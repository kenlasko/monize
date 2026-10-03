import { matchGlobWithCaptures } from "../../transaction-rules/rule-glob-capture";
import { isPlainReceiptAmount } from "./receipt-amount";
import { matchReceiptPattern } from "./receipt-glob";

const always = (): boolean => true;
const plainAmount = (c: Readonly<Record<string, string>>): boolean =>
  c.amount !== undefined && isPlainReceiptAmount(c.amount);
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

describe("matchReceiptPattern: the lazy reading comes first", () => {
  it("returns exactly what the rules' matcher returns when accepted", () => {
    const cases: [string, string][] = [
      ["{qty} x {name} ${amount}", "2 x USB-C cable $19.98"],
      ["Order total: {amount}", "Order total: 37.97"],
      ["*Grand total*{amount}", "Grand total incl. VAT 37.97"],
      ["{a}={b}", "k=v=w"],
    ];
    for (const [pattern, line] of cases) {
      expect(plain(matchReceiptPattern(pattern, line, always))).toEqual(
        plain(matchGlobWithCaptures(line, pattern)),
      );
    }
  });

  it("does not consult the greedy reading when the lazy one is accepted", () => {
    // Lazy: name "a", rest "b c"; greedy would give name "a b".
    const captures = matchReceiptPattern("{name} {rest}", "a b c", always);
    expect(captures).toEqual({ name: "a", rest: "b c" });
  });

  it("answers a capture-less pattern through the rules' matcher", () => {
    expect(matchReceiptPattern("Total*", "Total 5", always)).toEqual({});
    expect(matchReceiptPattern("Total*", "Sum 5", always)).toBeNull();
    // Refused by accept: no second reading exists for a pattern without captures.
    expect(matchReceiptPattern("Total*", "Total 5", () => false)).toBeNull();
  });
});

describe("matchReceiptPattern: the greedy reading", () => {
  it("gives a multi-word name to `{name} {amount}`", () => {
    expect(
      matchReceiptPattern("{name} {amount}", "USB-C cable 19.98", plainAmount),
    ).toEqual({ name: "USB-C cable", amount: "19.98" });
  });

  it("reads `{qty} x {name} {amount}` on a line without a delimiter", () => {
    expect(
      matchReceiptPattern(
        "{qty} x {name} {amount}",
        "2 x USB-C cable 19.98",
        plainAmount,
      ),
    ).toEqual({ qty: "2", name: "USB-C cable", amount: "19.98" });
  });

  it("finds each literal at its rightmost position", () => {
    const captures = matchReceiptPattern(
      "{a}-{b}-{c}",
      "x-y-z-w",
      (c) => c.a === "x-y",
    );
    expect(captures).toEqual({ a: "x-y", b: "z", c: "w" });
  });

  it("lets a capture before a trailing star take the run", () => {
    expect(
      matchReceiptPattern(
        "*order #{orderid}*",
        "Your order #12345 has shipped",
        (c) => c.orderid !== "",
      ),
    ).toEqual({ orderid: "12345 has shipped" });
  });

  it("gives the last of adjacent captures the run, the others nothing", () => {
    expect(
      matchReceiptPattern("{a}{b} end", "xyz end", (c) => c.b !== ""),
    ).toEqual({ a: "", b: "xyz" });
  });

  it("is case-insensitive and keeps the case of the text", () => {
    expect(
      matchReceiptPattern(
        "ITEM: {name} {amount}",
        "item: Red Mug 4.50",
        plainAmount,
      ),
    ).toEqual({ name: "Red Mug", amount: "4.50" });
  });

  it("trims a capture and cuts it to 200 characters", () => {
    const long = "w".repeat(300);
    const captures = matchReceiptPattern(
      "{name} {amount}",
      `${long} 5.00`,
      plainAmount,
    );
    expect(captures?.name).toHaveLength(200);
    expect(captures?.amount).toBe("5.00");
    const padded = matchReceiptPattern("[{a}]", "[  x  ]", always);
    expect(padded).toEqual({ a: "x" });
  });

  it("slices the folded text when case folding changes its length", () => {
    const dotted = String.fromCharCode(0x130);
    const captures = matchReceiptPattern(
      "{name} {amount}",
      `${dotted} cable 19.98`,
      plainAmount,
    );
    expect(captures?.amount).toBe("19.98");
    expect(captures?.name).toHaveLength(`${dotted} cable`.toLowerCase().length);
  });

  it("skips a line that neither reading accepts", () => {
    expect(
      matchReceiptPattern("{name} {amount}", "USB-C cable free", plainAmount),
    ).toBeNull();
    expect(
      matchReceiptPattern("{name} {amount}", "Pen 5.00", () => false),
    ).toBeNull();
  });

  it("returns null where the pattern cannot match at all", () => {
    // Head literal, tail literal, overlap of the two, a missing middle literal.
    expect(matchReceiptPattern("Item {name}", "Thing Pen", always)).toBeNull();
    expect(matchReceiptPattern("{name} EUR", "Pen USD", always)).toBeNull();
    expect(matchReceiptPattern("ab{x}ba", "aba", always)).toBeNull();
    expect(matchReceiptPattern("{a}-{b}", "no dash", always)).toBeNull();
  });

  it("returns null when the right-to-left search runs out of room", () => {
    // Lazy finds "b" then "ab"? No: the second literal must start after the first.
    expect(matchReceiptPattern("a{x}ab{y}b", "aabb", () => false)).toBeNull();
    expect(matchReceiptPattern("a{x}b{y}bb", "abb", () => false)).toBeNull();
    // Room for the last literal only at the start of the text, before the head.
    expect(matchReceiptPattern("ab{x}b{y}", "abb", () => false)).toBeNull();
    // A literal whose rightmost match lies before the head ends.
    expect(
      matchReceiptPattern("abc{x}b{y}", "abcxb", (c) => c.x === ""),
    ).toBeNull();
  });

  it("never matches a line or a pattern over 500 characters", () => {
    expect(matchReceiptPattern("{name}", "x".repeat(501), always)).toBeNull();
    expect(
      matchReceiptPattern(`${"x".repeat(501)}{name}`, "x", always),
    ).toBeNull();
  });

  it("stays fast on a 500 character line with many literals", () => {
    const pattern = "{a} x {b} x {c} x {d} x {e}";
    const line = "x ".repeat(249).trimEnd();
    const started = Date.now();
    for (let i = 0; i < 200; i++) {
      matchReceiptPattern(pattern, line, () => false);
    }
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
