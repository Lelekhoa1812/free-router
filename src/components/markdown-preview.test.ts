import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./markdown-preview";

describe("MarkdownPreview", () => {
  it("renders common Markdown, GFM tables, and highlighted code safely", () => {
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { content: [
      "## Status",
      "",
      "| Check | Result |",
      "| --- | --- |",
      "| ready | yes |",
      "",
      "```typescript",
      "const ready: boolean = true;",
      "```",
      "",
      "<script>alert('unsafe')</script>",
      "",
      "[unsafe](javascript:alert(1))",
    ].join("\n") }));

    expect(html).toContain("<h2>Status</h2>");
    expect(html).toContain("<table>");
    expect(html).toContain("language-typescript");
    expect(html).toContain("hljs-keyword");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("href=\"javascript:");
  });

  it("recognizes Mermaid fences for client-side diagram rendering", () => {
    const html = renderToStaticMarkup(createElement(MarkdownPreview, { content: "```mermaid\nflowchart LR\n  A --> B\n```" }));
    expect(html).toContain("Rendering diagram");
    expect(html).toContain('aria-label="Formatted model response"');
  });
});
