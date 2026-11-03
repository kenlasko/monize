import { Tokenizer } from "htmlparser2";

/**
 * The tables of an HTML page, read in ONE pass of htmlparser2's tokenizer with
 * a table builder of its own, and nothing else.
 *
 * Why not `parseDocument` or htmlparser2's `Parser`: both keep a stack of every
 * open element and walk it on each closing tag, so their cost grows with the
 * square of the nesting depth. A page of a few hundred kilobytes of
 * `<thead>`, of `<div></span>` (a closing tag that matches nothing) or of
 * nested tables held the event loop for seconds, a 5 MB one for minutes, and a
 * pre-scan meant to refuse such pages could not agree with the tree builder it
 * was guarding (PR #1995, second review). The tokenizer is a linear state
 * machine; everything below does constant work per token:
 *
 * - only `table`, `tr`, `td`/`th` and the section tags build structure, held on
 *   a stack of open TABLES (at most `MAX_OPEN_TABLES`), never of elements; a
 *   closing tag pops or ignores, it never searches;
 * - inside a cell, other elements are only counted (`depth`), to split the
 *   cell's text into the text of each direct child element (`parts`), which is
 *   how a responsive table writes one value twice;
 * - `script`, `style`, `title` and `textarea` bodies are text the tokenizer
 *   already reads as raw, and their text is dropped;
 * - every collection is capped (`MAX_TABLES`, `MAX_ITEMS_PER_PAGE`,
 *   `MAX_CELL_TEXT`, `MAX_CELL_PARTS`), so the output is bounded by constants
 *   as well as by the (capped) page.
 *
 * A table nested in a cell is a table of its own, and its text is not the
 * cell's: the same reading the DOM walk it replaces gave.
 */

/** One `<td>`/`<th>`: its whole text, its direct children's texts, its colspan. */
export interface PageCell {
  text: string;
  parts: string[];
  span: number;
}

/** One `<table>`'s own rows, in document order. */
export interface PageTable {
  rows: PageCell[][];
}

/** Tables read per page; a page of thousands of tables is not a quote page. */
export const MAX_TABLES = 200;
/** Tables open inside one another at once; deeper ones are skipped whole. */
const MAX_OPEN_TABLES = 32;
/**
 * Rows and cells kept per page, counted together: a 40-year daily history with
 * ten columns is ~110,000. Past it, further rows and cells are dropped, so a
 * page of nothing but `<tr>` cannot build a million empty rows.
 */
const MAX_ITEMS_PER_PAGE = 300_000;
/** Characters kept per cell; a price or a date is a few dozen. */
const MAX_CELL_TEXT = 512;
/** Child texts kept per cell. */
const MAX_CELL_PARTS = 8;
/** The widest colspan honoured, so one cell cannot claim a million columns. */
const MAX_COLSPAN = 20;

const VOID_TAGS: ReadonlySet<string> = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose text is never a cell's (the tokenizer reads them as raw text). */
const DROPPED_TEXT_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "title",
  "textarea",
]);

const SECTION_TAGS: ReadonlySet<string> = new Set([
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "colgroup",
]);

interface OpenCell {
  cell: PageCell;
  /** Elements open inside the cell; 0 means text is the cell's own. */
  depth: number;
  /** The text of the direct child element being read, while `depth > 0`. */
  part: string;
}

interface OpenTable {
  table: PageTable;
  row: PageCell[] | null;
  cell: OpenCell | null;
}

/** Every table on the page, in the order their `<table>` tags open. */
export function readPageTables(html: string): PageTable[] {
  const tables: PageTable[] = [];
  const open: OpenTable[] = [];
  let itemsKept = 0;
  /** `<table>`s opened past a cap, whose whole content is skipped. */
  let skippedTables = 0;
  let droppedText: string | null = null;

  let tagName = "";
  let attrName = "";
  let attrValue = "";
  let colspan = 1;

  const top = (): OpenTable | undefined => open[open.length - 1];

  const appendText = (text: string): void => {
    if (droppedText !== null || skippedTables > 0) return;
    const current = top()?.cell;
    if (!current) return;
    const room = MAX_CELL_TEXT - current.cell.text.length;
    if (room > 0) current.cell.text += text.slice(0, room);
    if (current.depth > 0 && current.part.length < MAX_CELL_TEXT) {
      current.part += text.slice(0, MAX_CELL_TEXT - current.part.length);
    }
  };

  const finishPart = (current: OpenCell): void => {
    if (current.part.trim() && current.cell.parts.length < MAX_CELL_PARTS) {
      current.cell.parts.push(current.part);
    }
    current.part = "";
  };

  const closeCell = (table: OpenTable): void => {
    if (table.cell && table.cell.depth > 0) finishPart(table.cell);
    table.cell = null;
  };

  const openTag = (): void => {
    const name = tagName;
    if (droppedText !== null) return;
    if (DROPPED_TEXT_TAGS.has(name)) {
      droppedText = name;
      return;
    }
    if (skippedTables > 0) {
      if (name === "table") skippedTables++;
      return;
    }
    if (name === "table") {
      if (tables.length >= MAX_TABLES || open.length >= MAX_OPEN_TABLES) {
        skippedTables = 1;
        return;
      }
      const table: PageTable = { rows: [] };
      tables.push(table);
      open.push({ table, row: null, cell: null });
      return;
    }
    const current = top();
    if (!current) return;
    if (name === "tr" || SECTION_TAGS.has(name)) {
      closeCell(current);
      current.row = null;
      if (name === "tr" && itemsKept < MAX_ITEMS_PER_PAGE) {
        current.row = [];
        current.table.rows.push(current.row);
        itemsKept++;
      }
      return;
    }
    if (name === "td" || name === "th") {
      closeCell(current);
      if (itemsKept >= MAX_ITEMS_PER_PAGE) return;
      if (!current.row) {
        current.row = [];
        current.table.rows.push(current.row);
        itemsKept++;
      }
      const cell: PageCell = { text: "", parts: [], span: colspan };
      current.row.push(cell);
      current.cell = { cell, depth: 0, part: "" };
      itemsKept++;
      return;
    }
    if (current.cell && !VOID_TAGS.has(name)) {
      if (current.cell.depth === 0) current.cell.part = "";
      current.cell.depth++;
    }
  };

  const closeTag = (name: string): void => {
    if (droppedText !== null) {
      if (name === droppedText) droppedText = null;
      return;
    }
    if (skippedTables > 0) {
      if (name === "table") skippedTables--;
      return;
    }
    const current = top();
    if (!current) return;
    if (name === "table") {
      closeCell(current);
      open.pop();
      return;
    }
    if (name === "tr" || SECTION_TAGS.has(name)) {
      closeCell(current);
      current.row = null;
      return;
    }
    if (name === "td" || name === "th") {
      closeCell(current);
      return;
    }
    const cell = current.cell;
    if (cell && cell.depth > 0 && !VOID_TAGS.has(name)) {
      cell.depth--;
      if (cell.depth === 0) finishPart(cell);
    }
  };

  const tokenizer = new Tokenizer(
    { decodeEntities: true },
    {
      onopentagname(start, end) {
        tagName = html.slice(start, end).toLowerCase();
        colspan = 1;
      },
      onattribname(start, end) {
        attrName = html.slice(start, end).toLowerCase();
        attrValue = "";
      },
      onattribdata(start, end) {
        if (attrName === "colspan" && attrValue.length < 8) {
          attrValue += html.slice(start, end);
        }
      },
      onattribentity() {
        // A colspan is digits; an entity in one is not a number.
      },
      onattribend() {
        if (attrName === "colspan") {
          const span = Number(attrValue);
          colspan = Number.isInteger(span)
            ? Math.min(Math.max(span, 1), MAX_COLSPAN)
            : 1;
        }
        attrName = "";
      },
      onopentagend() {
        openTag();
      },
      onselfclosingtag() {
        // HTML ignores the slash: `<td/>` opens a cell like `<td>`.
        openTag();
      },
      onclosetag(start, end) {
        closeTag(html.slice(start, end).toLowerCase());
      },
      ontext(start, end) {
        appendText(html.slice(start, end));
      },
      ontextentity(codepoint) {
        appendText(String.fromCodePoint(codepoint));
      },
      oncdata() {},
      oncomment() {},
      ondeclaration() {},
      onprocessinginstruction() {},
      onend() {},
    },
  );
  tokenizer.write(html);
  tokenizer.end();
  return tables;
}
