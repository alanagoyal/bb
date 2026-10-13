import { Mark, Node, getHTMLFromFragment } from "@tiptap/core";
import { DOMParser, type Schema } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
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

const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

function decodeAttribute(value: string): string {
  return value.replace(
    /&(amp|quot|lt|gt|nbsp);/g,
    (_match, name: string) => ENTITIES[name]!,
  );
}

export function restoreRawHtml(markdown: string): string {
  return markdown
    .replace(
      /<span data-docs-raw-html="true" data-source="([^"]*)">[^<]*<\/span>/g,
      (_match, source: string) => decodeAttribute(source),
    )
    .replace(
      /<[a-z]+ data-docs-html-open="([^"]*)" data-docs-html-close="[^"]*">/g,
      (_match, open: string) => decodeAttribute(open),
    );
}

function phrasingTag(source: string): string | undefined {
  const tag = /^<([a-z]+)(?:\s[^>]*)?>$/i.exec(source)?.[1]?.toLowerCase();
  return tag && !source.endsWith("/>") && PHRASING_TAGS.has(tag)
    ? tag
    : undefined;
}

function pairTags(tokens: InlineToken[]): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: { tag: string; index: number; level: number; text: number }[] =
    [];
  const counts = new Map<string, number>();
  const key = (tag: string, level: number) => `${level}:${tag}`;
  const pop = () => {
    const entry = stack.pop()!;
    const entryKey = key(entry.tag, entry.level);
    counts.set(entryKey, counts.get(entryKey)! - 1);
    return entry;
  };
  let level = 0;
  let text = 0;
  tokens.forEach((token, index) => {
    if (token.type !== "html_inline") {
      level += token.nesting;
      while (stack.length > 0 && stack.at(-1)!.level > level) pop();
      if (token.type === "text" && token.content) text++;
      return;
    }
    const tag = phrasingTag(token.content);
    if (tag) {
      stack.push({ tag, index, level, text });
      counts.set(key(tag, level), (counts.get(key(tag, level)) ?? 0) + 1);
      return;
    }
    const closing = /^<\/([a-z]+)>$/.exec(token.content)?.[1];
    if (!closing || !counts.get(key(closing, level))) return;
    let entry = pop();
    while (entry.tag !== closing) entry = pop();
    if (entry.text < text) {
      pairs.set(entry.index, index);
      pairs.set(index, -1);
    }
  });
  return pairs;
}

const pairsByTokens = new WeakMap<InlineToken[], Map<number, number>>();

function stripPastedSources(html: string): string {
  const body = new window.DOMParser().parseFromString(html, "text/html").body;
  for (const element of body.querySelectorAll("[data-docs-html-open]")) {
    element.removeAttribute("data-docs-html-open");
    element.removeAttribute("data-docs-html-close");
  }
  return body.innerHTML;
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
  renderHTML({ node }) {
    const source = String(node.attrs.source);
    return [
      "div",
      { "data-docs-raw-html": "true", "data-source": source },
      ["pre", {}, source],
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
      tables: new Map<string, boolean>(),
      markdown: {
        serialize: serializeSource,
        parse: {
          setup(markdown) {
            const { schema, storage } = this.editor;
            const previous: Map<string, boolean> = storage.rawHtml.tables;
            const tables = new Map<string, boolean>();
            storage.rawHtml.tables = tables;
            const isEditable = (source: string) => {
              const editable =
                tables.get(source) ??
                previous.get(source) ??
                isEditorTable(source, schema);
              tables.set(source, editable);
              return editable;
            };
            markdown.renderer.rules.html_block = (tokens, index) => {
              const source = tokens[index]!.content;
              if (
                /^<div data-simple-html-embed="true" data-src="[^"]*" data-height="\d+"><\/div>\s*$/.test(
                  source,
                ) ||
                isEditable(source)
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
    return [{ tag: "span[data-docs-raw-html]" }];
  },
  renderHTML({ node }) {
    const source = String(node.attrs.source);
    return [
      "span",
      { "data-docs-raw-html": "true", "data-source": source },
      source,
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
              let pairs = pairsByTokens.get(tokens);
              if (!pairs) {
                pairs = pairTags(tokens);
                pairsByTokens.set(tokens, pairs);
              }
              const token = tokens[index]!;
              const close = pairs.get(index);
              if (close === -1) return "</span>";
              if (close !== undefined) {
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
  addProseMirrorPlugins() {
    return [
      new Plugin({ props: { transformPastedHTML: stripPastedSources } }),
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize: {
          open: (_state, mark) => String(mark.attrs.open),
          close: (_state, mark) => String(mark.attrs.close),
          mixable: true,
        },
      } satisfies MarkdownMarkSpec,
    };
  },
});
