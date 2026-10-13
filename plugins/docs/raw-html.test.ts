// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { Markdown } from "tiptap-markdown";
import { describe, expect, it } from "vitest";
import {
  RawHtml,
  RawHtmlMark,
  RawInlineHtml,
  restoreRawHtml,
} from "./raw-html";

function createEditor(content: string) {
  return new Editor({
    extensions: [
      StarterKit,
      Table,
      TableRow,
      TableHeader,
      TableCell,
      RawHtml,
      RawInlineHtml,
      RawHtmlMark,
      Markdown.configure({ html: true }),
    ],
    content,
  });
}

describe("raw HTML blocks", () => {
  it.each([
    '<video autoplay loop muted playsinline>\n  <source src="/demo.mp4?a=1&amp;b=2" type="video/mp4">\n</video>',
    '<video controls><a href="/demo.mp4">Watch the demo</a></video>',
    '<iframe src="https://example.com" allowfullscreen></iframe>',
    '<section data-custom="a &quot;quote&quot;">\n\n<p>Nested HTML</p>\n\n</section>',
    "<!-- keep this comment -->",
    "<script>window.untrusted = true;</script>",
    '<div onclick="alert(1)"><img src="missing" onerror="alert(2)"></div>',
    '> <div>\n> <video src="/demo.mp4"></video>\n> </div>',
    '- Item\n\n  <div>\n  <video src="/demo.mp4"></video>\n  </div>',
  ])("retains exact source across edits and repeated loads: %s", (html) => {
    const editor = createEditor(`Before.\n\n${html}\n\nAfter.`);
    try {
      expect(
        editor.view.dom.querySelector(
          "video, iframe, script, img[src], [onclick]",
        ),
      ).toBeNull();
      editor.commands.insertContentAt(1, "Edited ");
      const saved: string = editor.storage.markdown.getMarkdown();
      expect(saved).toContain(html);
      expect(saved).toContain("Edited Before.");
      editor.commands.setContent(saved);
      expect(editor.storage.markdown.getMarkdown()).toBe(saved);
    } finally {
      editor.destroy();
    }
  });

  it("leaves fenced HTML as editable code", () => {
    const content = '```html\n<video controls src="demo.mp4"></video>\n```';
    const editor = createEditor(content);
    try {
      expect(editor.view.dom.querySelector(".simple-html-embed")).toBeNull();
      expect(editor.storage.markdown.getMarkdown()).toBe(content);
    } finally {
      editor.destroy();
    }
  });

  it("keeps multiple blocks distinct and supports explicit deletion and undo", () => {
    const first = '<video src="first.mp4">\n</video>';
    const second = '<audio src="second.mp3">\n</audio>';
    const editor = createEditor(`${first}\n\nBetween.\n\n${second}`);
    try {
      editor.commands.deleteRange({ from: 0, to: 1 });
      expect(editor.storage.markdown.getMarkdown()).not.toContain(first);
      expect(editor.storage.markdown.getMarkdown()).toContain(second);
      editor.commands.undo();
      const saved: string = editor.storage.markdown.getMarkdown();
      expect(saved).toContain(first);
      expect(saved).toContain(second);
      expect(saved.indexOf(first)).toBeLessThan(saved.indexOf(second));
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ["<strong>formatted</strong>", "strong", "formatted"],
    ["<b>bold <i>both</i></b>", "b i", "both"],
    ["<kbd>Ctrl</kbd>", "kbd", "Ctrl"],
    ["<sub>2</sub>", "sub", "2"],
    ['<a href="https://x.dev" target="_blank">docs</a>', "a", "docs"],
    ["<span>**bold** in span</span>", "span strong", "bold"],
    ["**Press <kbd>Ctrl</kbd> now**", "kbd", "Ctrl"],
    ["*H<sub>2</sub>O*", "sub", "2"],
  ])(
    "displays inline formatting tag %s and saves its exact source",
    (html, selector, text) => {
      const content = `Before ${html} after.`;
      const editor = createEditor(content);
      try {
        expect(editor.view.dom.querySelector(selector)?.textContent).toBe(
          text,
        );
        expect(editor.view.dom.textContent).not.toContain("<");
        expect(editor.view.dom.querySelector("[href]")).toBeNull();
        editor.commands.insertContentAt(1, "Edited ");
        const saved: string = editor.storage.markdown.getMarkdown();
        expect(saved).toBe(`Edited ${content}`);
        editor.commands.setContent(saved);
        expect(editor.storage.markdown.getMarkdown()).toBe(saved);
      } finally {
        editor.destroy();
      }
    },
  );

  it("displays a line break for inline br", () => {
    const editor = createEditor("one<br>two");
    try {
      expect(editor.view.dom.querySelector("p br")).not.toBeNull();
      expect(editor.view.dom.textContent).toBe("onetwo");
      expect(editor.storage.markdown.getMarkdown()).toBe("one<br>two");
    } finally {
      editor.destroy();
    }
  });

  it.each([
    'Anchor <a name="top"></a> here.',
    "Bad <b>a **c</b> d** end.",
    "<video controls>fallback</video> after.",
  ])("shows unsupported or unpaired inline HTML as source: %s", (content) => {
    const editor = createEditor(content);
    try {
      expect(editor.view.dom.textContent).toContain("<");
      expect(editor.storage.markdown.getMarkdown()).toBe(content);
    } finally {
      editor.destroy();
    }
  });

  function splitHeaderCell(editor: Editor) {
    let end = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.isText && node.text === "b") end = pos + 1;
    });
    editor.chain().setTextSelection(end).splitBlock().run();
  }

  it("keeps a table it saved as HTML editable", () => {
    const editor = createEditor(
      "| a | b |\n| --- | --- |\n| one<br>two | <strong>s</strong> |",
    );
    try {
      splitHeaderCell(editor);
      const saved = restoreRawHtml(editor.storage.markdown.getMarkdown());
      expect(saved).toMatch(/^<table/);
      expect(saved).toContain("one<br>two");
      expect(saved).toContain("<strong>s</strong>");
      expect(saved).not.toContain("data-docs-");
      editor.commands.setContent(saved);
      expect(editor.view.dom.querySelector("table td br")).not.toBeNull();
      expect(restoreRawHtml(editor.storage.markdown.getMarkdown())).toBe(saved);
    } finally {
      editor.destroy();
    }
  });

  it("writes original inline HTML when a table is saved as HTML", () => {
    const cells = [
      '<a href="https://x.test" target="_blank">x</a>',
      '<kbd>k</kbd> <video src="v.mp4"></video>',
    ];
    const editor = createEditor(
      `| a | b |\n| --- | --- |\n| ${cells[0]} | ${cells[1]} |`,
    );
    try {
      splitHeaderCell(editor);
      const saved = restoreRawHtml(editor.storage.markdown.getMarkdown());
      for (const cell of cells) expect(saved).toContain(cell);
      expect(saved).not.toContain("data-docs-");
      editor.commands.setContent(saved);
      expect(editor.view.dom.querySelector("table")).toBeNull();
      expect(editor.storage.markdown.getMarkdown()).toBe(saved);
    } finally {
      editor.destroy();
    }
  });

  it("preserves a hand-written HTML table as source", () => {
    const table = '<table>\n<tr><td align="right">x</td></tr>\n</table>';
    const editor = createEditor(`${table}\n\nAfter.`);
    try {
      expect(editor.view.dom.querySelector("table")).toBeNull();
      expect(editor.storage.markdown.getMarkdown()).toContain(table);
    } finally {
      editor.destroy();
    }
  });
});
