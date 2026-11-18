import {
  gzip,
  kmyAccount,
  kmyElement,
  kmyFile,
  kmyPayee,
  kmyPrice,
  kmyPricePair,
  kmySchedule,
  kmySecurity,
  kmySplit,
  kmySplitWith,
  kmyStandardAccounts,
  kmyTag,
  kmyTransaction,
  toKmyBytes,
} from "./kmy-xml-builders";
import { gunzipSync } from "zlib";

describe("kmy-xml-builders", () => {
  it("escapes attribute values and omits undefined ones", () => {
    expect(kmyElement("X", { a: 'q"<&>\n', b: undefined, c: 1 })).toBe(
      '<X a="q&quot;&lt;&amp;&gt;&#10;" c="1"/>',
    );
    expect(kmyElement("X", {}, ["<Y/>", "<Z/>"])).toBe("<X><Y/><Z/></X>");
  });

  it("adds the five standard roots to a file automatically", () => {
    expect(kmyStandardAccounts()).toHaveLength(5);
    const xml = kmyFile();
    for (const id of ["Asset", "Liability", "Expense", "Income", "Equity"]) {
      expect(xml).toContain(`id="AStd::${id}"`);
    }
    expect(kmyFile({ standardAccounts: false })).not.toContain("AStd::");
  });

  it("writes sections in the writer's order with USD as the base currency", () => {
    const xml = kmyFile();
    const order = [
      "FILEINFO",
      "INSTITUTIONS",
      "PAYEES",
      "COSTCENTERS",
      "TAGS",
      "ACCOUNTS",
      "TRANSACTIONS",
      "KEYVALUEPAIRS",
      "SCHEDULES",
      "SECURITIES",
      "CURRENCIES",
      "PRICES",
      "REPORTS",
      "BUDGETS",
      "ONLINEJOBS",
    ].map((n) => xml.indexOf(`<${n}`));
    expect(order.every((at, i) => at > (order[i - 1] ?? -1))).toBe(true);
    expect(xml).toContain('<PAIR key="kmm-baseCurrency" value="USD"/>');
  });

  it("builds an account with its children", () => {
    const xml = kmyAccount(
      { id: "A9" },
      {
        kvp: { iban: "X" },
        subaccounts: ["A10"],
        reconciliations: [{ date: "2024-01-31", value: "1/1" }],
        onlineBanking: { provider: "p" },
      },
    );
    expect(xml).toContain('<SUBACCOUNT id="A10"/>');
    expect(xml).toContain('<RECONCILIATION date="2024-01-31" value="1/1"/>');
    expect(xml).toContain('<ONLINEBANKING provider="p"/>');
    expect(xml).toContain('<PAIR key="iban" value="X"/>');
  });

  it("builds splits, transactions, schedules, securities, prices, payees and tags", () => {
    expect(kmySplit({ value: "5/1" })).toContain('value="5/1"');
    expect(kmySplitWith({}, { tags: ["G1"], kvp: { k: "v" } })).toMatch(
      /^<SPLIT .*><TAG id="G1"\/><KEYVALUEPAIRS><PAIR key="k" value="v"\/><\/KEYVALUEPAIRS><\/SPLIT>$/,
    );
    expect(
      kmyTransaction([kmySplit()], { id: "T9" }, { Imported: "true" }),
    ).toMatch(
      /<TRANSACTION id="T9".*<SPLITS><SPLIT .*<\/SPLITS><KEYVALUEPAIRS>/,
    );
    expect(kmySchedule([kmySplit()])).toContain('<TRANSACTION id=""');
    expect(kmySecurity({ symbol: "ABC" }, { a: "b" })).toContain(
      'symbol="ABC"',
    );
    expect(kmyPricePair("A", "B", [kmyPrice()])).toBe(
      '<PRICEPAIR from="A" to="B"><PRICE date="2024-02-10" price="50/1" source="Transaction"/></PRICEPAIR>',
    );
    expect(kmyPayee({}, "<ADDRESS/>")).toContain("<ADDRESS/>");
    expect(kmyTag()).toContain('closed="0"');
  });

  it("produces gzip and plain bytes", () => {
    const xml = kmyFile();
    expect(gunzipSync(toKmyBytes(xml, "gzip")).toString()).toBe(xml);
    expect(toKmyBytes(xml, "xml").toString()).toBe(xml);
    expect(gunzipSync(gzip(Buffer.from("abc"))).toString()).toBe("abc");
  });
});
