import { readPageTables } from "./html-table-reader";

describe("readPageTables", () => {
  it("reads each table's own rows and cells, a nested table apart", () => {
    const [outer, inner] = readPageTables(
      "<table><tr><th>Date</th><th colspan=2>Close</th></tr>" +
        "<tr><td>2026-11-02<table><tr><td>note</td></tr></table></td>" +
        "<td><span>5.10</span><span>5.1</span></td></tr></table>",
    );
    expect(outer.rows.map((row) => row.map((c) => c.text))).toEqual([
      ["Date", "Close"],
      ["2026-11-02", "5.105.1"],
    ]);
    expect(outer.rows[0][1].span).toBe(2);
    expect(outer.rows[1][1].parts).toEqual(["5.10", "5.1"]);
    expect(inner.rows[0][0].text).toBe("note");
  });

  it("decodes entities and drops script and style text", () => {
    const [table] = readPageTables(
      "<table><tr><td>3.609,23&nbsp;&euro;<script>x()</script>" +
        "<style>td{}</style></td></tr></table>",
    );
    expect(table.rows[0][0].text).toBe("3.609,23 €");
  });

  it("caps a colspan and ignores a non-numeric one", () => {
    const [table] = readPageTables(
      '<table><tr><td colspan="999999">a</td><td colspan="x">b</td></tr></table>',
    );
    expect(table.rows[0].map((c) => c.span)).toEqual([20, 1]);
  });

  it("keeps a bounded number of rows from a page of nothing but <tr>", () => {
    const [table] = readPageTables(
      `<table>${"<tr>".repeat(1_000_000)}</table>`,
    );
    expect(table.rows.length).toBeLessThanOrEqual(300_000);
  });

  it("reads at most 200 tables, and skips the content of the rest", () => {
    const tables = readPageTables(
      "<table><tr><td>x</td></tr></table>".repeat(300),
    );
    expect(tables).toHaveLength(200);
  });

  it("skips tables nested deeper than it tracks, without losing the outer one", () => {
    const deep =
      "<table><tr><td>".repeat(40) + "deep" + "</td></tr></table>".repeat(40);
    const tables = readPageTables(
      `${deep}<table><tr><td>after</td></tr></table>`,
    );
    expect(tables.length).toBe(33);
    expect(tables[32].rows[0][0].text).toBe("after");
  });
});
