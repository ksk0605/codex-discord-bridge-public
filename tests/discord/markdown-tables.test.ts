import stringWidth from "string-width";
import { describe, expect, it } from "vitest";
import { chunkDiscordText } from "../../src/discord/format.js";
import { chunkDiscordMarkdown } from "../../src/discord/markdown-tables.js";

const BASIC_TABLE = ["| Name | Status |", "| --- | --- |", "| API | Ready |"].join("\n");

const BASIC_RENDERED = ["```", "Name  Status", "----  ------", "API   Ready", "```"].join("\n");

function fencedBodyLines(chunk: string): readonly string[] {
  expect(chunk.startsWith("```\n")).toBe(true);
  expect(chunk.endsWith("\n```")).toBe(true);
  return chunk.slice(4, -4).split("\n");
}

function expectNoUnpairedSurrogates(value: string): void {
  expect(value).not.toMatch(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u,
  );
}

describe("chunkDiscordMarkdown", () => {
  it("renders a GFM table as one aligned Discord code block", () => {
    expect(chunkDiscordMarkdown(BASIC_TABLE)).toEqual([BASIC_RENDERED]);
  });

  it("recognizes a GFM table without outer pipes", () => {
    const input = ["Name | Status", "--- | ---", "API | Ready"].join("\n");

    expect(chunkDiscordMarkdown(input)).toEqual([BASIC_RENDERED]);
  });

  it("keeps surrounding prose in ordered nonblank messages", () => {
    const input = `Before\n\n${BASIC_TABLE}\n\nAfter`;

    expect(chunkDiscordMarkdown(input)).toEqual(["Before", BASIC_RENDERED, "After"]);
  });

  it("removes only table-adjacent CRLF separators from surrounding prose", () => {
    const input = `Before\r\n\r\n${BASIC_TABLE.replaceAll("\n", "\r\n")}\r\n\r\nAfter`;

    expect(chunkDiscordMarkdown(input)).toEqual(["Before", BASIC_RENDERED, "After"]);
  });

  it.each([
    "Use alpha | beta in prose.",
    ["Name | Status", "-- | ---", "API | Ready"].join("\n"),
    ["```md", BASIC_TABLE, "```"].join("\n"),
    ["~~~md", BASIC_TABLE, "~~~"].join("\n"),
  ])("preserves non-table input exactly: %s", (input) => {
    const options = { limit: 32, mode: "newline" as const };

    expect(chunkDiscordMarkdown(input, options)).toEqual(chunkDiscordText(input, options));
  });

  it("keeps every rendered chunk within the configured Discord limit", () => {
    const chunks = chunkDiscordMarkdown(BASIC_TABLE, { limit: 64, mode: "length" });

    expect(chunks).toEqual([BASIC_RENDERED]);
    expect(chunks.every((chunk) => chunk.length <= 64)).toBe(true);
  });

  it("aligns Korean, emoji, combining marks, and mixed-width ASCII by display width", () => {
    const input = [
      "| 이름 | 상태 |",
      "| --- | --- |",
      "| API | 실행 중 |",
      "| e\u0301 | ✅ |",
    ].join("\n");

    const [chunk] = chunkDiscordMarkdown(input);
    const lines = fencedBodyLines(chunk ?? "");

    expect(stringWidth(lines[0]?.slice(0, lines[0].indexOf("상태")) ?? "")).toBe(6);
    expect(stringWidth(lines[2]?.slice(0, lines[2].indexOf("실행")) ?? "")).toBe(6);
    expect(stringWidth(lines[3]?.slice(0, lines[3].indexOf("✅")) ?? "")).toBe(6);
  });

  it("applies default, left, center, and right alignment", () => {
    const input = [
      "| Default | Left | Center | Right |",
      "| --- | :--- | :---: | ---: |",
      "| a | b | c | d |",
    ].join("\n");

    const [chunk] = chunkDiscordMarkdown(input);
    const row = fencedBodyLines(chunk ?? "")[2] ?? "";

    expect(stringWidth(row.slice(0, row.indexOf("a")))).toBe(0);
    expect(stringWidth(row.slice(0, row.indexOf("b")))).toBe(9);
    expect(stringWidth(row.slice(0, row.indexOf("c")))).toBe(17);
    expect(stringWidth(row.slice(0, row.indexOf("d")))).toBe(27);
  });

  it("renders visible inline Markdown text without markers or link destinations", () => {
    const input = [
      "| Kind | Value |",
      "| --- | --- |",
      "| escaped | alpha \\| beta |",
      "| code | `alpha \\| beta` |",
      "| style | **bold** and [OpenAI](https://openai.com) |",
    ].join("\n");

    const body = chunkDiscordMarkdown(input).flatMap(fencedBodyLines).join("\n");

    expect(body.match(/alpha \| beta/gu)).toHaveLength(2);
    expect(body).toContain("bold and OpenAI");
    expect(body).not.toContain("**");
    expect(body).not.toContain("https://openai.com");
  });

  it("paginates long tables into complete blocks with repeated headers", () => {
    const rows = Array.from(
      { length: 12 },
      (_, index) => `| ${(index + 1).toString().padStart(2, "0")} | ready |`,
    );
    const input = ["| ID | Status |", "| --- | --- |", ...rows].join("\n");

    const chunks = chunkDiscordMarkdown(input, { limit: 80, mode: "length" });
    const bodies = chunks.map(fencedBodyLines);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 80)).toBe(true);
    expect(bodies.every((lines) => lines[0] === "ID   Status" && lines[1] === "---  ------")).toBe(
      true,
    );
    expect(
      bodies.flatMap((lines) => lines.slice(2).map((line) => line.trim().split(/\s+/u)[0])),
    ).toEqual(rows.map((_, index) => (index + 1).toString().padStart(2, "0")));
  });

  it("wraps wide cells at grapheme boundaries while retaining aligned row columns", () => {
    const value = "A😀e\u0301한".repeat(8);
    const input = ["| ID | Value |", "| --- | --- |", `| one | ${value} |`].join("\n");

    const chunks = chunkDiscordMarkdown(input, { limit: 60, mode: "length" });
    const bodies = chunks.map(fencedBodyLines);
    const reconstructed = bodies
      .flatMap((lines) => lines.slice(2))
      .map((line) => line.slice(5).trimEnd())
      .join("");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 60)).toBe(true);
    expect(
      bodies.every((lines) => lines[0] === bodies[0]?.[0] && lines[1] === bodies[0]?.[1]),
    ).toBe(true);
    expect(reconstructed).toBe(value);
    for (const chunk of chunks) expectNoUnpairedSurrogates(chunk);
  });

  it("splits excess columns into deterministic groups and repeats the first column", () => {
    const input = ["| ID | A | B | C |", "| --- | --- | --- | --- |", "| r1 | a | b | c |"].join(
      "\n",
    );

    const chunks = chunkDiscordMarkdown(input, { limit: 47, mode: "length" });
    const bodies = chunks.map(fencedBodyLines);

    expect(bodies).toHaveLength(3);
    expect(bodies.map((lines) => lines[0])).toEqual(["ID   A", "ID   B", "ID   C"]);
    expect(bodies.map((lines) => lines[2])).toEqual(["r1   a", "r1   b", "r1   c"]);
    expect(chunks.every((chunk) => chunk.length <= 47)).toBe(true);
  });

  it("falls back exactly when the limit cannot contain a fenced header", () => {
    const options = { limit: 15, mode: "length" as const };

    expect(chunkDiscordMarkdown(BASIC_TABLE, options)).toEqual(
      chunkDiscordText(BASIC_TABLE, options),
    );
  });

  it("falls back exactly for visible triple backticks", () => {
    const input = ["| Value |", "| --- |", "| ```` ``` ```` |"].join("\n");
    const options = { limit: 64, mode: "length" as const };

    expect(chunkDiscordMarkdown(input, options)).toEqual(chunkDiscordText(input, options));
  });

  it("falls back for the complete response when a later table is unsafe", () => {
    const unsafeTable = ["| Value |", "| --- |", "| ```` ``` ```` |"].join("\n");
    const input = `${BASIC_TABLE}\n\nBetween\n\n${unsafeTable}`;
    const options = { limit: 64, mode: "length" as const };

    expect(chunkDiscordMarkdown(input, options)).toEqual(chunkDiscordText(input, options));
  });

  it("falls back exactly when the table-count bound is exceeded", () => {
    const input = Array.from({ length: 65 }, (_, index) =>
      [`| H${index} |`, "| --- |", `| V${index} |`].join("\n"),
    ).join("\n\n");

    expect(chunkDiscordMarkdown(input)).toEqual(chunkDiscordText(input));
  });

  it("falls back exactly when the row-count bound is exceeded", () => {
    const input = ["| H |", "| --- |", ...Array.from({ length: 512 }, () => "| V |")].join("\n");

    expect(chunkDiscordMarkdown(input)).toEqual(chunkDiscordText(input));
  });

  it("falls back exactly when the cell-count bound is exceeded", () => {
    const header = `| ${Array.from({ length: 64 }, (_, index) => `H${index}`).join(" | ")} |`;
    const delimiter = `| ${Array.from({ length: 64 }, () => "---").join(" | ")} |`;
    const row = `| ${Array.from({ length: 64 }, () => "V").join(" | ")} |`;
    const input = [header, delimiter, ...Array.from({ length: 128 }, () => row)].join("\n");

    expect(chunkDiscordMarkdown(input)).toEqual(chunkDiscordText(input));
  });

  it("falls back exactly when the generated-line bound is exceeded", () => {
    const input = ["| H |", "| --- |", `| ${"a".repeat(20_000)} |`].join("\n");
    const options = { limit: 20, mode: "length" as const };

    expect(chunkDiscordMarkdown(input, options)).toEqual(chunkDiscordText(input, options));
  });
});
