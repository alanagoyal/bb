import {
  Mark,
  Node,
  getHTMLFromFragment,
  mergeAttributes,
} from "@tiptap/core";
import { DOMParser, type Schema } from "@tiptap/pm/model";
import type { MarkdownMarkSpec, MarkdownNodeSpec } from "tiptap-markdown";

type SerializeArgs = Parameters<MarkdownNodeSpec["serialize"]>;
type InlineToken = { type: string; content: string; nesting: number };

const PHRASING_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "cite",
  "code",
  "del",
  "em",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "u",
  "var",
]);

function serializeSource(state: SerializeArgs[0], node: SerializeArgs[1]) {
  state.text(String(node.attrs.source).replace(/\n$/, ""), false);
  if (node.isBlock) state.closeBlock(node);
}

function isEditorTable(source: string, schema: Schema): boolean {
  if (!/^<table[\s>]/i.test(source)) return false;
  const parse = (html: string) =>
    new window.DOMParser().parseFromString(html, "text/html").body;
  const table = parse(
    getHTMLFromFragment(
      DOMParser.fromSchema(schema).parse(parse(source)).content,
      schema,
    ),
  ).firstElementChild;
  if (!table) return false;
  table.innerHTML = `\n${table.innerHTML}\n`;
  return table.outerHTML === source.replace(/\n$/, "");
}

function phrasingTag(source: string): string | undefined {
  const tag = /^<([a-z]+)(?:\s[^>]*)?>$/i.exec(source)?.[1]?.toLowerCase();
  return tag && !source.endsWith("/>") && PHRASING_TAGS.has(tag)
    ? tag
    : undefined;
}

function closingIndex(
  tokens: InlineToken[],
  index: number,
  tag: string,
): number | undefined {
  const closing = new RegExp(`^</${tag}\\s*>$`, "i");
  let depth = 0;
  let nesting = 0;
  let hasText = false;
  for (let next = index + 1; next < tokens.length; next++) {
    const token = tokens[next]!;
    if (token.type !== "html_inline") {
      nesting += token.nesting;
      if (nesting < 0) return undefined;
      hasText ||= token.type === "text" && token.content.length > 0;
    } else if (phrasingTag(token.content) === tag) depth++;
    else if (closing.test(token.content)) {
      if (depth > 0) depth--;
      else return nesting === 0 && hasText ? next : undefined;
    }
  }
  return undefined;
}

export const RawHtml = Node.create({
  name: "rawHtml",
  group: "block",
  atom: true,
  isolating: true,
  addAttributes() {
    return {
      source: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-source") ?? "",
      },
    };
  },
  parseHTML() {
    return [{ tag: "div[data-docs-raw-html]" }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-docs-raw-html": "true",
        "data-source": String(node.attrs.source),
      }),
      ["pre", {}, String(node.attrs.source)],
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("section");
      dom.className = "simple-html-embed";
      dom.contentEditable = "false";
      const header = document.createElement("div");
      header.className = "simple-html-embed-header";
      header.textContent = "HTML block · preserved · edit in source";
      const source = document.createElement("pre");
      source.textContent = String(node.attrs.source);
      dom.append(header, source);
      return { dom };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize: serializeSource,
        parse: {
          setup(markdown) {
            const { schema } = this.editor;
            markdown.renderer.rules.html_block = (tokens, index) => {
              const source = tokens[index]!.content;
              if (
                /^<div data-simple-html-embed="true" data-src="[^"]*" data-height="\d+"><\/div>\s*$/.test(
                  source,
                ) ||
                isEditorTable(source, schema)
              ) {
                return source;
              }
              return `<div data-docs-raw-html="true" data-source="${markdown.utils.escapeHtml(source)}"><pre>${markdown.utils.escapeHtml(source)}</pre></div>`;
            };
          },
        },
      } satisfies MarkdownNodeSpec,
    };
  },
});

export const RawInlineHtml = RawHtml.extend({
  name: "rawInlineHtml",
  group: "inline",
  inline: true,
  parseHTML() {
    return [
      { tag: "span[data-docs-raw-html]" },
      { tag: "br[data-docs-raw-html]", priority: 60 },
    ];
  },
  renderHTML({ node }) {
    const source = String(node.attrs.source);
    return [
      /^<br\s*\/?>$/i.test(source) ? "br" : "span",
      { "data-docs-raw-html": "true", "data-source": source },
    ];
  },
  addNodeView() {
    return ({ node }) => {
      const source = String(node.attrs.source);
      if (/^<br\s*\/?>$/i.test(source))
        return { dom: document.createElement("br") };
      const dom = document.createElement("span");
      dom.contentEditable = "false";
      dom.title = "HTML · preserved · edit in source";
      dom.textContent = source;
      return { dom };
    };
  },
  addStorage() {
    return {
      markdown: {
        serialize: serializeSource,
        parse: {
          setup(markdown) {
            const escape = markdown.utils.escapeHtml;
            markdown.renderer.rules.html_inline = (tokens, index) => {
              const token = tokens[index]!;
              if (token.meta?.docsHtmlClose) return "</span>";
              const tag = phrasingTag(token.content);
              const close =
                tag === undefined
                  ? undefined
                  : closingIndex(tokens, index, tag);
              if (close !== undefined) {
                tokens[close]!.meta = { docsHtmlClose: true };
                return `<span data-docs-html-open="${escape(token.content)}" data-docs-html-close="${escape(tokens[close]!.content)}">`;
              }
              return `<span data-docs-raw-html="true" data-source="${escape(token.content)}"></span>`;
            };
          },
        },
      } satisfies MarkdownNodeSpec,
    };
  },
});

export const RawHtmlMark = Mark.create({
  name: "rawHtmlMark",
  priority: 1000,
  excludes: "",
  addAttributes() {
    return {
      open: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-docs-html-open"),
        renderHTML: (attributes) => ({
          "data-docs-html-open": String(attributes.open),
        }),
      },
      close: {
        default: "",
        parseHTML: (element) => element.getAttribute("data-docs-html-close"),
        renderHTML: (attributes) => ({
          "data-docs-html-close": String(attributes.close),
        }),
      },
    };
  },
  parseHTML() {
    return [{ tag: "[data-docs-html-open]", priority: 60 }];
  },
  renderHTML({ mark, HTMLAttributes }) {
    return [phrasingTag(String(mark.attrs.open)) ?? "span", HTMLAttributes, 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state, mark) => String(mark.attrs.open),
          close: (_state, mark) => String(mark.attrs.close),
        },
      } satisfies MarkdownMarkSpec,
    };
  },
});
