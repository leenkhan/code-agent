import { describe, expect, it } from "vitest";
import { displayWidth, fitDisplayLine, renderMarkdown, stripAnsiCodes, wrapDisplayLine } from "../src/ui/markdown.js";

describe("markdown terminal rendering", () => {
  it("renders headings, inline styles, lists, quotes, and code blocks", () => {
    const rendered = renderMarkdown([
      "## Summary",
      "Use **bold** text and `code` spans.",
      "- first",
      "  - nested",
      "1. ordered",
      "> quoted",
      "```",
      "const answer = 42;",
      "```"
    ].join("\n"));

    expect(rendered).toContain("\u001b[1m\u001b[36mSummary");
    expect(rendered).toContain("\u001b[1mbold\u001b[0m");
    expect(rendered).toContain("\u001b[48;5;236m code \u001b[0m");
    expect(stripAnsiCodes(rendered)).toContain("- first");
    expect(stripAnsiCodes(rendered)).toContain("  - nested");
    expect(stripAnsiCodes(rendered)).toContain("1. ordered");
    expect(stripAnsiCodes(rendered)).toContain("| quoted");
    expect(stripAnsiCodes(rendered)).toContain("  const answer = 42;");
  });

  it("renders markdown tables as unicode border tables", () => {
    const rendered = renderMarkdown([
      "| Name | Value |",
      "| --- | --- |",
      "| API | `ok` |",
      "| Longer | **bold** |"
    ].join("\n"));
    const visible = stripAnsiCodes(rendered);

    expect(visible).toContain("┌────────┬───────┐");
    expect(visible).toContain("│ Name   │ Value │");
    expect(visible).toContain("├────────┼───────┤");
    expect(visible).toContain("│ API    │  ok   │");
    expect(visible).toContain("│ Longer │ bold  │");
    expect(visible).toContain("└────────┴───────┘");
    expect(visible).not.toContain("| --- |");
  });

  it("keeps Chinese table width stable with double-width cells", () => {
    const rendered = renderMarkdown([
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| 登录 | 完成 |"
    ].join("\n"));
    const visible = stripAnsiCodes(rendered);

    expect(visible).toContain("┌──────┬──────┐");
    expect(visible).toContain("│ 项目 │ 状态 │");
    expect(visible).toContain("│ 登录 │ 完成 │");
    for (const line of visible.split("\n")) {
      expect(displayWidth(line)).toBe(15);
    }
  });

  it("keeps emoji and star rating table columns aligned", () => {
    const rendered = renderMarkdown([
      "| Item | Rating |",
      "| --- | --- |",
      "| Search | ⭐⭐⭐⭐ |",
      "| Deploy | ✅ |"
    ].join("\n"));
    const visible = stripAnsiCodes(rendered);
    const lines = visible.split("\n");

    expect(visible).toContain("│ Search │ ⭐⭐⭐⭐");
    expect(visible).toContain("│ Deploy │ ✅");
    expect(new Set(lines.map((line) => displayWidth(line))).size).toBe(1);
  });

  it("ignores ANSI styles and inline code padding when measuring table columns", () => {
    const rendered = renderMarkdown([
      "| Name | State |",
      "| --- | --- |",
      "| **粗体** | `ok` |",
      "| plain | done |"
    ].join("\n"));
    const lines = rendered.split("\n");
    const visible = stripAnsiCodes(rendered);

    expect(rendered).toContain("\u001b[1m粗体\u001b[0m");
    expect(rendered).toContain("\u001b[48;5;236m ok \u001b[0m");
    expect(visible).not.toContain("| --- |");
    expect(new Set(lines.map((line) => displayWidth(line))).size).toBe(1);
  });

  it("wraps and fits ANSI plus wide text without breaking escape sequences", () => {
    const styled = "\u001b[1m中文abc😀def\u001b[0m";
    const wrapped = wrapDisplayLine(styled, 6);

    expect(wrapped.every((line) => displayWidth(line) <= 6)).toBe(true);
    expect(wrapped.join("")).toBe(styled);
    expect(fitDisplayLine(styled, 7)).not.toMatch(/\u001b\[[0-9;?]*[ -/]*$/);
    expect(displayWidth(fitDisplayLine(styled, 7))).toBe(7);
    expect(displayWidth(fitDisplayLine("中文a", 6))).toBe(6);
  });
});
