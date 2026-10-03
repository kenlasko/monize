import {
  selectReceiptParser,
  type SelectableReceiptParser,
} from "./select-receipt-parser";

const parser = (
  id: string,
  over: Partial<SelectableReceiptParser> = {},
): SelectableReceiptParser => ({
  id,
  status: "approved",
  fromDomains: ["shop.example.com"],
  subjectContains: [],
  createdAt: new Date("2026-09-01T00:00:00Z"),
  ...over,
});

const pick = (
  parsers: SelectableReceiptParser[],
  domain: string,
  subject = "Your order",
) => selectReceiptParser(parsers, domain, subject)?.id ?? null;

describe("selectReceiptParser", () => {
  describe("domain", () => {
    it("matches the domain itself", () => {
      expect(pick([parser("a")], "shop.example.com")).toBe("a");
    });

    it("matches a sub-domain on a label boundary", () => {
      expect(pick([parser("a")], "mail.shop.example.com")).toBe("a");
    });

    it("does not match a domain that merely ends with the same letters", () => {
      expect(pick([parser("a")], "notshop.example.com")).toBeNull();
      expect(pick([parser("a")], "xshop.example.com")).toBeNull();
    });

    it("does not match the parent of the parser domain", () => {
      expect(pick([parser("a")], "example.com")).toBeNull();
    });

    it("compares case-insensitively and ignores a trailing dot", () => {
      expect(pick([parser("a")], "Mail.SHOP.example.com.")).toBe("a");
    });

    it("matches any one of several domains", () => {
      const p = parser("a", {
        fromDomains: ["a.example.com", "b.example.org"],
      });
      expect(pick([p], "b.example.org")).toBe("a");
    });

    it("never matches an empty sender", () => {
      expect(pick([parser("a")], "")).toBeNull();
    });

    it("ignores a blank parser domain", () => {
      expect(
        pick([parser("a", { fromDomains: [" ", "."] })], "shop.example.com"),
      ).toBeNull();
    });
  });

  describe("specificity", () => {
    it("the longest matching domain wins, whatever the order", () => {
      const general = parser("general", { fromDomains: ["example.com"] });
      const specific = parser("specific", {
        fromDomains: ["orders.shop.example.com"],
      });
      expect(pick([general, specific], "orders.shop.example.com")).toBe(
        "specific",
      );
      expect(pick([specific, general], "orders.shop.example.com")).toBe(
        "specific",
      );
      expect(pick([general, specific], "news.example.com")).toBe("general");
    });

    it("a parser is judged by its best matching domain", () => {
      const many = parser("many", {
        fromDomains: ["example.com", "deep.orders.shop.example.com"],
      });
      const mid = parser("mid", { fromDomains: ["shop.example.com"] });
      expect(pick([mid, many], "deep.orders.shop.example.com")).toBe("many");
    });

    it("a tie goes to the older parser, then to the lower id", () => {
      const older = parser("z", {
        createdAt: new Date("2026-08-01T00:00:00Z"),
      });
      const newer = parser("a", {
        createdAt: new Date("2026-09-01T00:00:00Z"),
      });
      expect(pick([newer, older], "shop.example.com")).toBe("z");
      const sameAge = [parser("b"), parser("a"), parser("c")];
      expect(pick(sameAge, "shop.example.com")).toBe("a");
      expect(pick([...sameAge].reverse(), "shop.example.com")).toBe("a");
    });
  });

  describe("subject words", () => {
    it("an empty list fits every subject", () => {
      expect(pick([parser("a")], "shop.example.com", "anything")).toBe("a");
    });

    it("at least one word must occur, case-insensitively", () => {
      const p = parser("a", { subjectContains: ["order", "receipt"] });
      expect(pick([p], "shop.example.com", "Your RECEIPT is here")).toBe("a");
      expect(pick([p], "shop.example.com", "Newsletter")).toBeNull();
    });

    it("lets a less specific parser read what a specific one's words refuse", () => {
      const specific = parser("specific", {
        fromDomains: ["orders.shop.example.com"],
        subjectContains: ["invoice"],
      });
      const general = parser("general", { fromDomains: ["example.com"] });
      expect(
        pick([specific, general], "orders.shop.example.com", "hello"),
      ).toBe("general");
    });

    it("ignores blank words, which would otherwise match everything", () => {
      const p = parser("a", { subjectContains: ["  "] });
      expect(pick([p], "shop.example.com", "hi")).toBe("a");
    });
  });

  it("never selects a draft", () => {
    expect(
      pick([parser("a", { status: "draft" })], "shop.example.com"),
    ).toBeNull();
    expect(
      pick(
        [
          parser("draft", {
            status: "draft",
            fromDomains: ["orders.shop.example.com"],
          }),
          parser("approved"),
        ],
        "orders.shop.example.com",
      ),
    ).toBe("approved");
  });

  it("returns null for no parsers", () => {
    expect(pick([], "shop.example.com")).toBeNull();
  });
});
