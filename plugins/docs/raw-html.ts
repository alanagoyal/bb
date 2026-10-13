import { Mark, Node, getHTMLFromFragment } from "@tiptap/core";
import { DOMParser, type Schema } from "@tiptap/pm/model";
import { Plugin } from "@tiptap/pm/state";
import type { MarkdownMarkSpec, MarkdownNodeSpec } from "tiptap-markdown";

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

const STRUCTURAL_TAGS = new Set([
  "BODY",
  "COLGROUP",
  "OL",
  "TABLE",
  "TBODY",
  "TFOOT",
  "THEAD",
  "TR",
  "UL",
]);
const TEXT_BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "P",
  "TD",
  "TH",
]);
const MIN_WIDTH = /^min-width: \d+px;?$/;
const ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  lt: "<",
  gt: ">",
  nbsp: "\u00a0",
};

function decodeHtml(value: string): string {
  return value.replace(
    /&(amp|quot|lt|gt|nbsp);/g,
    (_match, name: string) => ENTITIES[name]!,
  );
}

export function restoreRawHtml(markdown: string): string {
  return markdown
    .replace(
      /<pre data-docs-raw-html="true"><code>([^<]*)<\/code><\/pre>/g,
      (_match, source: string) => decodeHtml(source),
    )
    .replace(
      /<code data-docs-html-source="true">([^<]*)<\/code>/g,
      (_match, source: string) => decodeHtml(source),
    )
    .replace(
      /<br data-docs-html-break="true" data-source="([^"]*)">/g,
      (_match, source: string) => decodeHtml(source),
    )
    .replace(
      /<[a-z]+ data-docs-html-open="([^"]*)" data-docs-html-close="[^"]*">/g,
      (_match, open: string) => decodeHtml(open),
    );
}

function parseHtml(html: string): HTMLElement {
  return new window.DOMParser().parseFromString(html, "text/html").body;
}

function normalizeHtml(root: HTMLElement): HTMLElement {
  for (const section of root.querySelectorAll("thead, tbody, tfoot"))
    section.replaceWith(...section.childNodes);
  for (const element of root.querySelectorAll("table, col"))
    if (MIN_WIDTH.test(element.getAttribute("style") ?? ""))
      element.removeAttribute("style");
  for (const group of root.querySelectorAll("colgroup"))
    if ([...group.children].every((col) => col.attributes.length === 0))
      group.remove();
  for (const cell of root.querySelectorAll("td, th"))
    for (const name of ["colspan", "rowspan"])
      if (cell.getAttribute(name) === "1") cell.removeAttribute(name);
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode())
    if (walker.currentNode instanceof window.Text) texts.push(walker.currentNode);
  for (const text of texts) {
    const parent = text.parentElement!;
    if (parent.closest("pre")) continue;
    text.data = text.data.replace(/[ \t\r\n\f]+/g, " ");
    if (STRUCTURAL_TAGS.has(parent.tagName) && text.data === " ") text.remove();
    else if (TEXT_BLOCK_TAGS.has(parent.tagName)) {
      if (!text.previousSibling) text.data = text.data.trimStart();
      if (!text.nextSibling) text.data = text.data.trimEnd();
      if (!text.data) text.remove();
    }
  }
  for (const cell of root.querySelectorAll("td, th, li")) {
    const only = cell.firstChild;
    if (
      only === cell.lastChild &&
      only instanceof window.HTMLParagraphElement &&
      only.attributes.length === 0
    )
      only.replaceWith(...only.childNodes);
  }
  return root;
}

function isLossless(source: string, schema: Schema): boolean {
  const original = parseHtml(source);
  if (!original.textContent?.trim()) return false;
  const rendered = parseHtml(
    getHTMLFromFragment(
      DOMParser.fromSchema(schema).parse(original).content,
      schema,
    ),
  );
  return normalizeHtml(rendered).isEqualNode(normalizeHtml(original));
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
  const body = parseHtml(html);
  for (const element of body.querySelectorAll("[data-docs-html-open]")) {
    element.removeAttribute("data-docs-html-open");
    element.removeAttribute("data-docs-html-close");
  }
  return body.innerHTML;
}

export const RawHtmlBlock = Node.create({
  name: "rawHtmlBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  parseHTML() {
    return [
      {
        tag: "pre[data-docs-raw-html]",
        preserveWhitespace: "full",
        priority: 60,
      },
    ];
  },
  renderHTML() {
    return ["pre", { "data-docs-raw-html": "true" }, ["code", 0]];
  },
  addStorage() {
    return {
      lossless: new Map<string, boolean>(),
      markdown: {
        serialize(state, node) {
          state.text(node.textContent, false);
          state.closeBlock(node);
        },
        parse: {
          setup(markdown) {
            const { schema, storage } = this.editor;
            const previous: Map<string, boolean> =
              storage.rawHtmlBlock.lossless;
            const lossless = new Map<string, boolean>();
            storage.rawHtmlBlock.lossless = lossless;
            const isRich = (source: string) => {
              const rich =
                lossless.get(source) ??
                previous.get(source) ??
                isLossless(source, schema);
              lossless.set(source, rich);
              return rich;
            };
            markdown.renderer.rules.html_block = (tokens, index) => {
              const source = tokens[index]!.content;
              if (
                /^<div data-simple-html-embed="true" data-src="[^"]*" data-height="\d+"><\/div>\s*$/.test(
                  source,
                ) ||
                isRich(source)
              ) {
                return source;
              }
              return `<pre data-docs-raw-html="true"><code>${markdown.utils.escapeHtml(source.replace(/\n$/, ""))}</code></pre>`;
            };
          },
        },
      } satisfies MarkdownNodeSpec,
    };
  },
});

export const RawHtmlBreak = Node.create({
  name: "rawHtmlBreak",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      source: {
        default: "<br>",
        parseHTML: (element) => element.getAttribute("data-source") ?? "<br>",
      },
    };
  },
  parseHTML() {
    return [{ tag: "br[data-docs-html-break]", priority: 60 }];
  },
  renderHTML({ node }) {
    return [
      "br",
      {
        "data-docs-html-break": "true",
        "data-source": String(node.attrs.source),
      },
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize(state, node) {
          state.text(String(node.attrs.source), false);
        },
      } satisfies MarkdownNodeSpec,
    };
  },
});

export const RawHtmlInline = Mark.create({
  name: "rawHtmlInline",
  priority: 1,
  inclusive: false,
  parseHTML() {
    return [{ tag: "code[data-docs-html-source]", priority: 60 }];
  },
  renderHTML() {
    return ["code", { "data-docs-html-source": "true" }, 0];
  },
  addStorage() {
    return {
      markdown: {
        serialize: { open: "", close: "", escape: false },
        parse: {
          setup(markdown) {
            const escape = markdown.utils.escapeHtml;
            markdown.renderer.rules.html_inline = (tokens, index) => {
              let pairs = pairsByTokens.get(tokens);
              if (!pairs) {
                pairs = pairTags(tokens);
                pairsByTokens.set(tokens, pairs);
              }
              const source = tokens[index]!.content;
              const close = pairs.get(index);
              if (close === -1) return "</span>";
              if (close !== undefined)
                return `<span data-docs-html-open="${escape(source)}" data-docs-html-close="${escape(tokens[close]!.content)}">`;
              if (/^<br\s*\/?>$/i.test(source))
                return `<br data-docs-html-break="true" data-source="${escape(source)}">`;
              return `<code data-docs-html-source="true">${escape(source)}</code>`;
            };
          },
        },
      } satisfies MarkdownMarkSpec,
    };
  },
});

export const RawHtmlFormatting = Mark.create({
  name: "rawHtmlFormatting",
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
