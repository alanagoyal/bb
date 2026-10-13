// @vitest-environment jsdom
import { Editor } from "@tiptap/core";
import { DOMParser as ProseMirrorDOMParser } from "@tiptap/pm/model";
import StarterKit from "@tiptap/starter-kit";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import { Markdown } from "tiptap-markdown";
import { describe, expect, it } from "vitest";
import {
  RawHtmlBlock,
  RawHtmlBreak,
  RawHtmlFormatting,
  RawHtmlInline,
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
      RawHtmlBlock,
      RawHtmlBreak,
      RawHtmlInline,
      RawHtmlFormatting,
      Markdown.configure({ html: true }),
    ],
    content,
  });
}

function save(editor: Editor): string {
  return restoreRawHtml(editor.storage.markdown.getMarkdown());
}

function splitHeaderCell(editor: Editor) {
  let end = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "b") end = pos + 1;
  });
  editor.chain().setTextSelection(end).splitBlock().run();
}

describe("raw HTML", () => {
  it.each([
    '<video autoplay loop muted playsinline>\n  <source src="/demo.mp4?a=1&amp;b=2" type="video/mp4">\n</video>',
    '<video controls><a href="/demo.mp4">Watch the demo</a></video>',
    '<iframe src="https://example.com" allowfullscreen></iframe>',
    '<section data-custom="a &quot;quote&quot;">\n\n<p class="note">Nested HTML</p>\n\n</section>',
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
      const saved = save(editor);
      expect(saved).toContain(html);
      expect(saved).toContain("Edited Before.");
      editor.commands.setContent(saved);
      expect(save(editor)).toBe(saved);
    } finally {
      editor.destroy();
    }
  });

  it("saves edits typed into HTML source exactly", () => {
    const editor = createEditor(
      '<div>\n<video src="/a.mp4"></video>\n</div>\n\nText <video src="x.mp4"></video> end.',
    );
    try {
      let block = 0;
      let inline = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "rawHtmlBlock")
          block = pos + 1 + node.textContent.indexOf("a.mp4");
        if (node.isText && node.text?.includes("x.mp4"))
          inline = pos + node.text.indexOf("x.mp4");
      });
      editor
        .chain()
        .insertContentAt(inline, "new-")
        .insertContentAt(block, "b")
        .run();
      expect(save(editor)).toBe(
        '<div>\n<video src="/ba.mp4"></video>\n</div>\n\nText <video src="new-x.mp4"></video> end.',
      );
    } finally {
      editor.destroy();
    }
  });

  it("displays HTML the editor can represent as normal content", () => {
    const editor = createEditor(
      "<p>Some <strong>text</strong></p>\n\n<table>\n  <tr><th>a</th></tr>\n  <tr><td>1</td></tr>\n</table>",
    );
    try {
      expect(editor.view.dom.querySelector("p strong")?.textContent).toBe(
        "text",
      );
      expect(editor.view.dom.querySelector("table td")?.textContent).toBe("1");
      expect(editor.view.dom.querySelector("pre")).toBeNull();
      expect(save(editor)).toBe("Some **text**\n\n| a |\n| --- |\n| 1 |\n");
    } finally {
      editor.destroy();
    }
  });

  it("leaves fenced HTML as code", () => {
    const content = '```html\n<video controls src="demo.mp4"></video>\n```';
    const editor = createEditor(content);
    try {
      expect(editor.view.dom.querySelector("[data-docs-raw-html]")).toBeNull();
      expect(save(editor)).toBe(content);
    } finally {
      editor.destroy();
    }
  });

  it.each([
    ["<b>bold <i>both</i></b>", "b i", "both"],
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
        const saved = save(editor);
        expect(saved).toBe(`Edited ${content}`);
        editor.commands.setContent(saved);
        expect(save(editor)).toBe(saved);
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
      expect(save(editor)).toBe("one<br>two");
    } finally {
      editor.destroy();
    }
  });

  it.each([
    'Anchor <a name="top"></a> here.',
    "Bad <b>a **c</b> d** end.",
    "Mis-nested <b>a <i>b</b> c</i> end.",
    "<video controls>fallback</video> after.",
  ])("shows other inline HTML as editable source: %s", (content) => {
    const editor = createEditor(content);
    try {
      expect(
        editor.view.dom.querySelector("[data-docs-html-source]")?.textContent,
      ).toMatch(/^</);
      expect(save(editor)).toBe(content);
    } finally {
      editor.destroy();
    }
  });

  it("keeps a table it saved as HTML editable, including after reformatting", () => {
    const editor = createEditor(
      "| a | b |\n| --- | --- |\n| one<br>two | <strong>s</strong> |",
    );
    try {
      splitHeaderCell(editor);
      const saved = save(editor);
      expect(saved).toMatch(/^<table/);
      expect(saved).toContain("one<br>two");
      expect(saved).toContain("<strong>s</strong>");
      expect(saved).not.toContain("data-docs-");
      editor.commands.setContent(saved);
      expect(editor.view.dom.querySelector("table td br")).not.toBeNull();
      expect(save(editor)).toBe(saved);
      editor.commands.setContent(
        saved
          .replace(/<tr>/g, "\n  <tr>")
          .replace("</tbody>", "\n  <tr><td>3</td><td>4</td></tr>\n</tbody>"),
      );
      expect(editor.view.dom.querySelectorAll("table tr")).toHaveLength(3);
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
      const saved = save(editor);
      for (const cell of cells) expect(saved).toContain(cell);
      expect(saved).not.toContain("data-docs-");
      editor.commands.setContent(saved);
      expect(
        editor.view.dom.querySelector("pre[data-docs-raw-html]"),
      ).not.toBeNull();
      expect(save(editor)).toBe(saved);
    } finally {
      editor.destroy();
    }
  });

  it("keeps HTML whose attributes the editor would drop as source", () => {
    const table = '<table>\n<tr><td align="right">x</td></tr>\n</table>';
    const editor = createEditor(`${table}\n\nAfter.`);
    try {
      expect(editor.view.dom.querySelector("table")).toBeNull();
      expect(save(editor)).toContain(table);
    } finally {
      editor.destroy();
    }
  });

  it("pairs thousands of unclosed inline tags in linear time", () => {
    const editor = createEditor("");
    try {
      const started = performance.now();
      editor.storage.markdown.parser.parse(
        `x${'<a href="#">'.repeat(20_000)}`,
      );
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      editor.destroy();
    }
  });

  it("drops hidden HTML sources from pasted content", () => {
    const editor = createEditor("");
    try {
      let html = `<p>see <span data-docs-html-open='<a href="https://evil.example" onmouseover="alert(1)">' data-docs-html-close="</a>">this</span> ok</p>`;
      editor.view.someProp("transformPastedHTML", (transform) => {
        html = transform(html, editor.view);
      });
      const pasted = new window.DOMParser().parseFromString(html, "text/html");
      editor.view.dispatch(
        editor.state.tr.replaceSelection(
          ProseMirrorDOMParser.fromSchema(editor.schema).parseSlice(
            pasted.body,
          ),
        ),
      );
      expect(save(editor)).toBe("see this ok");
    } finally {
      editor.destroy();
    }
  });
});
