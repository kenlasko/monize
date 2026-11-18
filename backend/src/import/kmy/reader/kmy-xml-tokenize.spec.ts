import { KmyCorruptFileError } from "../model/kmy-errors";
import { KMY_MAX_DEPTH, tokenizeKmyXml } from "./kmy-xml-tokenize";

interface Event {
  kind: "open" | "close";
  path: string;
  attrs?: Record<string, string>;
}

function run(xml: string): Event[] {
  const events: Event[] = [];
  tokenizeKmyXml(Buffer.from(xml, "utf8"), {
    open: (path, attrs) =>
      events.push({ kind: "open", path, attrs: { ...attrs } }),
    close: (path) => events.push({ kind: "close", path }),
  });
  return events;
}

describe("tokenizeKmyXml", () => {
  it("emits open and close events keyed by element path", () => {
    expect(run('<KMYMONEY-FILE><A x="1"><B/></A></KMYMONEY-FILE>')).toEqual([
      { kind: "open", path: "KMYMONEY-FILE", attrs: {} },
      { kind: "open", path: "KMYMONEY-FILE/A", attrs: { x: "1" } },
      { kind: "open", path: "KMYMONEY-FILE/A/B", attrs: {} },
      { kind: "close", path: "KMYMONEY-FILE/A/B" },
      { kind: "close", path: "KMYMONEY-FILE/A" },
      { kind: "close", path: "KMYMONEY-FILE" },
    ]);
  });

  it("skips the declaration, DOCTYPE and comments", () => {
    const events = run(
      '<?xml version="1.0"?>\n<!DOCTYPE KMYMONEY-FILE>\n<KMYMONEY-FILE><!-- c --></KMYMONEY-FILE>',
    );
    expect(events.map((e) => e.kind)).toEqual(["open", "close"]);
  });

  it("decodes entities and character references in attributes", () => {
    const [, child] = run(
      '<KMYMONEY-FILE><A v="a&amp;b&#10;c&lt;&quot;"/></KMYMONEY-FILE>',
    );
    expect(child.attrs).toEqual({ v: 'a&b\nc<"' });
  });

  it("keeps unknown named entities literal", () => {
    const [, child] = run('<KMYMONEY-FILE><A v="&foo;"/></KMYMONEY-FILE>');
    expect(child.attrs).toEqual({ v: "&foo;" });
  });

  it("refuses a repeated attribute, as QXmlStreamReader does", () => {
    expect(() =>
      run('<KMYMONEY-FILE><A v="1" v="second"/></KMYMONEY-FILE>'),
    ).toThrow(KmyCorruptFileError);
    // The same name on two elements is fine.
    expect(() =>
      run('<KMYMONEY-FILE><A v="1"/><B v="2"/></KMYMONEY-FILE>'),
    ).not.toThrow();
  });

  it("refuses a character reference to a character XML 1.0 forbids", () => {
    expect(() => run('<KMYMONEY-FILE><A v="a&#1;b"/></KMYMONEY-FILE>')).toThrow(
      KmyCorruptFileError,
    );
    expect(() =>
      run('<KMYMONEY-FILE><A v="a&#9;&#10;&#13;b"/></KMYMONEY-FILE>'),
    ).not.toThrow();
  });

  it("accepts non-ASCII text, including across the 64 KB decode slice", () => {
    const padding = "x".repeat(64 * 1024 - 8);
    const events = run(`<KMYMONEY-FILE><A v="${padding}é€é"/></KMYMONEY-FILE>`);
    expect(events[1].attrs?.v).toBe(`${padding}é€é`);
  });

  it("refuses a root that is not KMYMONEY-FILE", () => {
    expect(() => run("<OTHER/>")).toThrow(KmyCorruptFileError);
  });

  it("refuses a document with no element", () => {
    expect(() => run("<!-- only a comment -->")).toThrow(KmyCorruptFileError);
  });

  it("refuses content after the root", () => {
    expect(() => run("<KMYMONEY-FILE/><KMYMONEY-FILE/>")).toThrow(
      KmyCorruptFileError,
    );
  });

  it("refuses an element that is not closed", () => {
    expect(() => run("<KMYMONEY-FILE><A><B></A></KMYMONEY-FILE>")).toThrow(
      KmyCorruptFileError,
    );
    expect(() => run("<KMYMONEY-FILE><A>")).toThrow(KmyCorruptFileError);
    expect(() => run("<KMYMONEY-FILE")).toThrow(KmyCorruptFileError);
  });

  it("refuses a close tag that matches nothing open", () => {
    expect(() => run("<KMYMONEY-FILE><A></B></A></KMYMONEY-FILE>")).toThrow(
      KmyCorruptFileError,
    );
  });

  it("allows depth 64 and refuses depth 65", () => {
    const nest = (depth: number) => {
      const inner = Array.from({ length: depth - 1 }, (_, i) => `<N${i}>`);
      const outer = inner
        .map((tag) => `</${tag.slice(1)}`)
        .reverse()
        .join("");
      return `<KMYMONEY-FILE>${inner.join("")}${outer}</KMYMONEY-FILE>`;
    };
    expect(KMY_MAX_DEPTH).toBe(64);
    expect(() => run(nest(64))).not.toThrow();
    expect(() => run(nest(65))).toThrow(KmyCorruptFileError);
  });
});
