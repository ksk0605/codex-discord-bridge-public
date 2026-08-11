import type { Root, Table } from "mdast";
import { toString as mdastToString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import stringWidth from "string-width";
import { unified } from "unified";
import { chunkDiscordText, DISCORD_MESSAGE_LIMIT, type DiscordChunkOptions } from "./format.js";

const MAX_MARKDOWN_SOURCE_LENGTH = 200_000;
const MAX_TABLES = 64;
const MAX_TABLE_ROWS = 512;
const MAX_TABLE_COLUMNS = 64;
const MAX_TABLE_CELLS = 8_192;
const MAX_GENERATED_LINES = 4_096;
const CODE_FENCE_OVERHEAD = 8;
const MIN_COLUMN_WIDTH = 3;
const COLUMN_GAP = 2;

type TableAlignment = "center" | "left" | "right" | null;

interface ParsedTable {
  readonly align: readonly TableAlignment[];
  readonly end: number;
  readonly rows: readonly (readonly string[])[];
  readonly start: number;
}

const MARKDOWN_PROCESSOR = unified().use(remarkParse).use(remarkGfm).freeze();
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function positionedOffset(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function visibleCellText(cell: Table["children"][number]["children"][number]): string {
  return mdastToString(cell).replace(/\s+/gu, " ").trim();
}

function parsedTable(node: Table): ParsedTable | undefined {
  const start = positionedOffset(node.position?.start.offset);
  const end = positionedOffset(node.position?.end.offset);
  const header = node.children[0];
  if (
    start === undefined ||
    end === undefined ||
    end <= start ||
    header === undefined ||
    header.children.length === 0 ||
    header.children.length > MAX_TABLE_COLUMNS ||
    node.children.length > MAX_TABLE_ROWS ||
    header.children.length * node.children.length > MAX_TABLE_CELLS
  ) {
    return undefined;
  }

  const columnCount = header.children.length;
  const rows: string[][] = [];
  for (const row of node.children) {
    if (row.children.length > columnCount) return undefined;
    const cells = row.children.map(visibleCellText);
    while (cells.length < columnCount) cells.push("");
    if (cells.some((cell) => cell.includes("```"))) return undefined;
    rows.push(cells);
  }
  const align = Array.from({ length: columnCount }, (_, index): TableAlignment => {
    const value = node.align?.[index];
    return value === "center" || value === "left" || value === "right" ? value : null;
  });
  return Object.freeze({
    align: Object.freeze(align),
    end,
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    start,
  });
}

function parseTables(text: string): readonly ParsedTable[] | undefined {
  const tree = MARKDOWN_PROCESSOR.parse(text) as Root;
  const nodes = tree.children.filter((node): node is Table => node.type === "table");
  if (nodes.length === 0) return Object.freeze([]);
  if (nodes.length > MAX_TABLES) return undefined;

  const tables: ParsedTable[] = [];
  let previousEnd = -1;
  for (const node of nodes) {
    const table = parsedTable(node);
    if (table === undefined || table.start < previousEnd || table.end > text.length) {
      return undefined;
    }
    tables.push(table);
    previousEnd = table.end;
  }
  return Object.freeze(tables);
}

function cellPadding(value: string, width: number, alignment: TableAlignment): string {
  const missing = Math.max(0, width - stringWidth(value));
  if (alignment === "right") return `${" ".repeat(missing)}${value}`;
  if (alignment === "center") {
    const left = Math.floor(missing / 2);
    return `${" ".repeat(left)}${value}${" ".repeat(missing - left)}`;
  }
  return `${value}${" ".repeat(missing)}`;
}

function tableLineWidth(widths: readonly number[]): number {
  return (
    widths.reduce((total, width) => total + width, 0) + Math.max(0, widths.length - 1) * COLUMN_GAP
  );
}

function minimumPageLineWidth(limit: number, hasBodyRows: boolean): number | undefined {
  const minimumLineCount = hasBodyRows ? 3 : 2;
  const available = limit - CODE_FENCE_OVERHEAD - (minimumLineCount - 1);
  if (available < minimumLineCount * MIN_COLUMN_WIDTH) return undefined;
  return Math.floor(available / minimumLineCount);
}

function columnGroups(
  columnCount: number,
  lineWidth: number,
): readonly (readonly number[])[] | undefined {
  if (columnCount === 1) {
    return lineWidth >= MIN_COLUMN_WIDTH ? Object.freeze([Object.freeze([0])]) : undefined;
  }

  const groups: number[][] = [];
  let nextColumn = 1;
  while (nextColumn < columnCount) {
    const group = [0];
    while (
      nextColumn < columnCount &&
      tableLineWidth(Array.from({ length: group.length + 1 }, () => MIN_COLUMN_WIDTH)) <= lineWidth
    ) {
      group.push(nextColumn);
      nextColumn += 1;
    }
    if (group.length === 1) return undefined;
    groups.push(group);
  }
  return Object.freeze(groups.map((group) => Object.freeze(group)));
}

function reducedWidths(
  naturalWidths: readonly number[],
  lineWidth: number,
): readonly number[] | undefined {
  const contentWidth = lineWidth - Math.max(0, naturalWidths.length - 1) * COLUMN_GAP;
  if (contentWidth < naturalWidths.length * MIN_COLUMN_WIDTH) return undefined;

  const widths = naturalWidths.map((width) => Math.max(MIN_COLUMN_WIDTH, width));
  let excess = widths.reduce((total, width) => total + width, 0) - contentWidth;
  while (excess > 0) {
    const maximum = Math.max(...widths);
    const widest = widths.flatMap((width, index) => (width === maximum ? [index] : []));
    const next = Math.max(MIN_COLUMN_WIDTH, ...widths.filter((width) => width < maximum));
    const reductionToNext = (maximum - next) * widest.length;
    if (reductionToNext <= excess) {
      for (const index of widest) widths[index] = next;
      excess -= reductionToNext;
      continue;
    }

    const shared = Math.floor(excess / widest.length);
    const remainder = excess % widest.length;
    for (const [position, index] of widest.entries()) {
      widths[index] = maximum - shared - (position < remainder ? 1 : 0);
    }
    excess = 0;
  }
  return Object.freeze(widths);
}

function wrapCell(value: string, width: number): readonly string[] | undefined {
  if (value.length === 0) return Object.freeze([""]);

  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (segmentWidth > width) return undefined;
    if (current.length > 0 && currentWidth + segmentWidth > width) {
      lines.push(current);
      if (lines.length > MAX_GENERATED_LINES) return undefined;
      current = segment;
      currentWidth = segmentWidth;
    } else {
      current += segment;
      currentWidth += segmentWidth;
    }
  }
  lines.push(current);
  return lines.length <= MAX_GENERATED_LINES ? Object.freeze(lines) : undefined;
}

function renderRow(
  row: readonly string[],
  columns: readonly number[],
  widths: readonly number[],
  alignments: readonly TableAlignment[],
): readonly string[] | undefined {
  const cells: (readonly string[])[] = [];
  for (const [position, column] of columns.entries()) {
    const wrapped = wrapCell(row[column] ?? "", widths[position] ?? MIN_COLUMN_WIDTH);
    if (wrapped === undefined) return undefined;
    cells.push(wrapped);
  }
  const height = Math.max(...cells.map((cell) => cell.length));
  if (height > MAX_GENERATED_LINES) return undefined;

  return Object.freeze(
    Array.from({ length: height }, (_, line) =>
      cells
        .map((cell, position) =>
          cellPadding(
            cell[line] ?? "",
            widths[position] ?? MIN_COLUMN_WIDTH,
            alignments[position] ?? null,
          ),
        )
        .join(" ".repeat(COLUMN_GAP))
        .trimEnd(),
    ),
  );
}

function fencedBlock(lines: readonly string[]): string {
  return `\`\`\`\n${lines.join("\n")}\n\`\`\``;
}

function renderColumnGroup(
  table: ParsedTable,
  columns: readonly number[],
  lineWidth: number,
  limit: number,
): readonly string[] | undefined {
  const alignments = columns.map((column) => table.align[column] ?? null);
  const naturalWidths = columns.map((column) =>
    Math.max(MIN_COLUMN_WIDTH, ...table.rows.map((row) => stringWidth(row[column] ?? ""))),
  );
  const widths = reducedWidths(naturalWidths, lineWidth);
  const header = table.rows[0];
  if (widths === undefined || header === undefined) return undefined;

  const headerLines = renderRow(header, columns, widths, alignments);
  if (headerLines === undefined) return undefined;
  const separator = widths.map((width) => "-".repeat(width)).join(" ".repeat(COLUMN_GAP));
  const baseLines = [...headerLines, separator];
  if (fencedBlock(baseLines).length > limit) return undefined;

  const pages: string[] = [];
  let pageRows: string[] = [];
  let generatedLines = 0;
  const flushPage = (): boolean => {
    if (pageRows.length === 0 && table.rows.length > 1) return true;
    const lines = [...baseLines, ...pageRows];
    generatedLines += lines.length;
    if (generatedLines > MAX_GENERATED_LINES) return false;
    const block = fencedBlock(lines);
    if (block.length > limit) return false;
    pages.push(block);
    pageRows = [];
    return true;
  };

  if (table.rows.length === 1) {
    return flushPage() ? Object.freeze(pages) : undefined;
  }

  for (const row of table.rows.slice(1)) {
    const rowLines = renderRow(row, columns, widths, alignments);
    if (rowLines === undefined) return undefined;
    const freshPage = fencedBlock([...baseLines, ...rowLines]);
    if (freshPage.length <= limit) {
      if (fencedBlock([...baseLines, ...pageRows, ...rowLines]).length > limit) {
        if (!flushPage()) return undefined;
      }
      pageRows.push(...rowLines);
      continue;
    }

    if (pageRows.length > 0 && !flushPage()) return undefined;
    for (const line of rowLines) {
      if (fencedBlock([...baseLines, ...pageRows, line]).length > limit) {
        if (pageRows.length === 0 || !flushPage()) return undefined;
      }
      if (fencedBlock([...baseLines, line]).length > limit) return undefined;
      pageRows.push(line);
    }
  }
  if (pageRows.length > 0 && !flushPage()) return undefined;
  return Object.freeze(pages);
}

function renderTable(table: ParsedTable, limit: number): readonly string[] | undefined {
  const columnCount = table.rows[0]?.length;
  if (columnCount === undefined || columnCount === 0) return undefined;
  const lineWidth = minimumPageLineWidth(limit, table.rows.length > 1);
  if (lineWidth === undefined) return undefined;
  const groups = columnGroups(columnCount, lineWidth);
  if (groups === undefined) return undefined;

  const output: string[] = [];
  let generatedLines = 0;
  for (const columns of groups) {
    const pages = renderColumnGroup(table, columns, lineWidth, limit);
    if (pages === undefined) return undefined;
    for (const page of pages) {
      generatedLines += page.split("\n").length - 2;
      if (generatedLines > MAX_GENERATED_LINES || page.length > limit) return undefined;
      output.push(page);
    }
  }
  return Object.freeze(output);
}

function plainSegment(value: string): string {
  return value.replace(/^[\r\n]+|[\r\n]+$/gu, "");
}

export function chunkDiscordMarkdown(
  text: string,
  options: DiscordChunkOptions = {},
): readonly string[] {
  const fallback = chunkDiscordText(text, options);
  if (text.length === 0 || text.length > MAX_MARKDOWN_SOURCE_LENGTH) return fallback;
  const limit = options.limit ?? DISCORD_MESSAGE_LIMIT;
  if (limit <= CODE_FENCE_OVERHEAD) return fallback;

  try {
    const tables = parseTables(text);
    if (tables === undefined || tables.length === 0) return fallback;

    const output: string[] = [];
    let cursor = 0;
    for (const table of tables) {
      const plain = plainSegment(text.slice(cursor, table.start));
      if (plain.length > 0) output.push(...chunkDiscordText(plain, options));
      const rendered = renderTable(table, limit);
      if (rendered === undefined) return fallback;
      output.push(...rendered);
      cursor = table.end;
    }
    const plain = plainSegment(text.slice(cursor));
    if (plain.length > 0) output.push(...chunkDiscordText(plain, options));
    return Object.freeze(output);
  } catch {
    return fallback;
  }
}
