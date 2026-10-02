import type { EmailT } from "../i18n/email-translator";
import {
  NO_BANK_OPERATION,
  OPERATION_CODE_PATTERN,
  findRemittanceOperation,
  operationTagLabel,
  remittanceOperationCode,
  type BankOperation,
  type OperationDirection,
} from "./bank-operation";
import { resolveProfile } from "./bank-sync-profiles";

const operation = (over: Partial<BankOperation> = {}): BankOperation => ({
  ...NO_BANK_OPERATION,
  ...over,
});

/** PKO BP's profile, which holds the operation-code table these cases were written against. */
const PKO_BP = resolveProfile("enable_banking", "PL", "PKO Bank Polski");

const pkoLabel = (
  value: BankOperation,
  t?: EmailT,
  direction?: OperationDirection | null,
) => operationTagLabel(value, PKO_BP, t, direction);

/** A translator that marks what it translated, so a label is seen to come from the catalogue. */
const polish: EmailT = (key, fallback) => `pl(${key})|${fallback}`;

describe("remittanceOperationCode", () => {
  it.each([
    ["CARD-PAYMENT", "CARD-PAYMENT"],
    ["TRANSFER-IN", "TRANSFER-IN"],
    [
      "MOBILE-PAYMENT-POS-NO-CARD-TX-CODE",
      "MOBILE-PAYMENT-POS-NO-CARD-TX-CODE",
    ],
    ["ATM-WITHDRAWAL", "ATM-WITHDRAWAL"],
    ["A1-B2", "A1-B2"],
  ])("reads a line that is a code: %s", (line, expected) => {
    expect(remittanceOperationCode([line])).toBe(expected);
  });

  it("reads the last whitespace-separated word of a line", () => {
    expect(remittanceOperationCode(["Zakupy 12.34 PLN CARD-PAYMENT"])).toBe(
      "CARD-PAYMENT",
    );
    expect(remittanceOperationCode(["  Zakupy   CARD-PAYMENT  "])).toBe(
      "CARD-PAYMENT",
    );
  });

  it("does not read a code that is not the last word, or not a code", () => {
    expect(remittanceOperationCode(["CARD-PAYMENT Zakupy"])).toBeNull();
    expect(remittanceOperationCode(["card-payment"])).toBeNull();
    expect(remittanceOperationCode(["CARDPAYMENT"])).toBeNull();
    expect(remittanceOperationCode(["-CARD-PAYMENT"])).toBeNull();
    expect(remittanceOperationCode(["CARD-"])).toBeNull();
    expect(remittanceOperationCode(["1CARD-PAYMENT"])).toBeNull();
    expect(remittanceOperationCode(["Zakupy"])).toBeNull();
    expect(remittanceOperationCode([])).toBeNull();
    expect(remittanceOperationCode(["", "   "])).toBeNull();
  });

  it("takes the first line that holds one", () => {
    expect(
      remittanceOperationCode(["Latte", "A CARD-PAYMENT", "B TRANSFER-IN"]),
    ).toBe("CARD-PAYMENT");
  });

  it("matches the pattern the spec names", () => {
    expect(OPERATION_CODE_PATTERN.source).toBe("^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$");
  });
});

describe("findRemittanceOperation", () => {
  it("names the line a whole-line code was found on", () => {
    expect(
      findRemittanceOperation(["SOMECITYSHOP NAME  10PL", "CARD-PAYMENT"]),
    ).toEqual({ code: "CARD-PAYMENT", lineIndex: 1, wholeLine: true });
  });

  it("says when the code was only the last word of a longer line", () => {
    expect(findRemittanceOperation(["Zakupy CARD-PAYMENT"])).toEqual({
      code: "CARD-PAYMENT",
      lineIndex: 0,
      wholeLine: false,
    });
  });

  it("takes the first line that holds one, as remittanceOperationCode does", () => {
    expect(
      findRemittanceOperation(["Latte", "A CARD-PAYMENT", "TRANSFER-IN"]),
    ).toEqual({ code: "CARD-PAYMENT", lineIndex: 1, wholeLine: false });
  });

  it("is null when no line holds one", () => {
    expect(findRemittanceOperation(["Latte", ""])).toBeNull();
    expect(findRemittanceOperation([])).toBeNull();
  });
});

describe("operationTagLabel", () => {
  it("is null when the bank named no operation", () => {
    expect(pkoLabel(NO_BANK_OPERATION)).toBeNull();
    expect(pkoLabel(operation({ code: "  ", description: "" }))).toBeNull();
  });

  it.each([
    ["CARD-PAYMENT", "CARD-PAYMENT", "Card payment"],
    ["TRANSFER-IN", "TRANSFER-IN", "Incoming transfer"],
    ["TRANSFER-OUT", "TRANSFER-OUT", "Outgoing transfer"],
    ["MOBILE-PAYMENT-POS-NO-CARD-TX-CODE", "MOBILE-PAYMENT", "Mobile payment"],
    ["MOBILE-PAYMENT-ONLINE", "MOBILE-PAYMENT", "Mobile payment"],
    [
      "MOBILE-PAYMENT-ATM-TX-CODE",
      "MOBILE-PAYMENT-ATM",
      "Cash withdrawal (BLIK)",
    ],
    [
      "MOBILE-PAYMENT-POS-RETURN",
      "MOBILE-PAYMENT-RETURN",
      "Mobile payment refund",
    ],
    ["ATM-WITHDRAWAL", "ATM", "Cash withdrawal"],
    ["ATM-FOREIGN", "ATM", "Cash withdrawal"],
    ["STANDING-ORDER", "STANDING-ORDER", "Standing order"],
    ["CASHBACK", "CASHBACK", "Cashback"],
    ["LOAN-PAYOFF", "LOAN-PAYOFF", "Loan repayment"],
    [
      "CREDIT-CARD-AUTO-REPAYMENT",
      "CREDIT-CARD-AUTO-REPAYMENT",
      "Credit card repayment",
    ],
  ])("gives the known code %s its label", (code, key, label) => {
    expect(pkoLabel(operation({ remittanceCode: code }))).toEqual({
      key,
      label,
    });
  });

  describe("a more specific rule wins", () => {
    it.each([
      // BLIK cash withdrawal over the mobile payment family.
      ["MOBILE-PAYMENT-ATM-TX-CODE", "Cash withdrawal (BLIK)"],
      ["MOBILE-PAYMENT-ATM-FOREIGN", "Cash withdrawal (BLIK)"],
      // A refund over the family, whatever sits between the family and RETURN.
      ["MOBILE-PAYMENT-POS-RETURN", "Mobile payment refund"],
      ["MOBILE-PAYMENT-ONLINE-RETURN", "Mobile payment refund"],
      // A refund of a BLIK cash withdrawal is a refund, not a withdrawal.
      ["MOBILE-PAYMENT-ATM-RETURN", "Mobile payment refund"],
      // What is neither falls to the family.
      ["MOBILE-PAYMENT-POS-NO-CARD-TX-CODE", "Mobile payment"],
      ["MOBILE-PAYMENT-ATOM", "Mobile payment"],
      // The card ATM family is not the BLIK one.
      ["ATM-MOBILE-PAYMENT-X", "Cash withdrawal"],
    ])("%s is %s", (code, label) => {
      expect(pkoLabel(operation({ remittanceCode: code }))?.label).toBe(label);
    });

    it("does not take a RETURN outside the mobile payment family for a mobile refund", () => {
      expect(pkoLabel(operation({ code: "CARD-RETURN" }))).toEqual({
        key: "CARD-RETURN",
        label: "CARD-RETURN",
      });
    });

    it("takes an exact code before any prefix", () => {
      expect(pkoLabel(operation({ remittanceCode: "CARD-PAYMENT" }))?.key).toBe(
        "CARD-PAYMENT",
      );
      expect(
        pkoLabel(operation({ remittanceCode: "TRANSFER-IN" }), polish)?.label,
      ).toContain("transferIn");
    });
  });

  describe("a bare TRANSFER is read by the direction", () => {
    it.each([
      ["credit", "TRANSFER-IN", "Incoming transfer"],
      ["debit", "TRANSFER-OUT", "Outgoing transfer"],
    ] as const)("%s is %s", (direction, key, label) => {
      expect(
        pkoLabel(
          operation({ remittanceCode: "TRANSFER" }),
          undefined,
          direction,
        ),
      ).toEqual({ key, label });
    });

    it("is translated through the same catalogue keys as the explicit codes", () => {
      expect(
        pkoLabel(operation({ remittanceCode: "TRANSFER" }), polish, "credit")
          ?.label,
      ).toBe("pl(common.bankSync.operationTypes.transferIn)|Incoming transfer");
      expect(
        pkoLabel(operation({ remittanceCode: "TRANSFER" }), polish, "debit")
          ?.label,
      ).toBe(
        "pl(common.bankSync.operationTypes.transferOut)|Outgoing transfer",
      );
    });

    it("is its own name when the direction is not known", () => {
      expect(pkoLabel(operation({ remittanceCode: "TRANSFER" }))).toEqual({
        key: "TRANSFER",
        label: "TRANSFER",
      });
      expect(
        pkoLabel(operation({ remittanceCode: "TRANSFER" }), undefined, null)
          ?.label,
      ).toBe("TRANSFER");
    });

    it("lets the explicit code win over the direction", () => {
      expect(
        pkoLabel(
          operation({ remittanceCode: "TRANSFER-IN" }),
          undefined,
          "debit",
        )?.label,
      ).toBe("Incoming transfer");
      expect(
        pkoLabel(
          operation({ remittanceCode: "TRANSFER-OUT" }),
          undefined,
          "credit",
        )?.label,
      ).toBe("Outgoing transfer");
    });

    it("does not read the direction into any other code", () => {
      expect(
        pkoLabel(
          operation({ remittanceCode: "CARD-PAYMENT" }),
          undefined,
          "credit",
        )?.label,
      ).toBe("Card payment");
    });
  });

  it("translates a known label through the recipient's translator, with the English as the fallback", () => {
    expect(
      pkoLabel(operation({ remittanceCode: "CARD-PAYMENT" }), polish),
    ).toEqual({
      key: "CARD-PAYMENT",
      label: "pl(common.bankSync.operationTypes.cardPayment)|Card payment",
    });
    expect(
      pkoLabel(operation({ remittanceCode: "ATM-X" }), polish)?.label,
    ).toBe("pl(common.bankSync.operationTypes.cashWithdrawal)|Cash withdrawal");
  });

  it("recognises a known code in any case", () => {
    expect(pkoLabel(operation({ code: "card-payment" }))).toEqual({
      key: "CARD-PAYMENT",
      label: "Card payment",
    });
  });

  it("names an unknown code after itself, as the bank wrote it, and does not translate it", () => {
    expect(
      pkoLabel(operation({ remittanceCode: "DIRECT-DEBIT" }), polish),
    ).toEqual({ key: "DIRECT-DEBIT", label: "DIRECT-DEBIT" });
    expect(pkoLabel(operation({ code: "Standing Order" }))).toEqual({
      key: "Standing Order",
      label: "Standing Order",
    });
  });

  it("does not take MOBILE-PAYMENT or ATM without their suffix for the known families", () => {
    expect(pkoLabel(operation({ code: "ATM" }))?.key).toBe("ATM");
    expect(pkoLabel(operation({ code: "ATM" }))?.label).toBe("ATM");
    expect(pkoLabel(operation({ code: "MOBILE-PAYMENT" }))?.label).toBe(
      "MOBILE-PAYMENT",
    );
  });

  it("prefers the remittance code, then the sub code, the code and the description", () => {
    const all = {
      remittanceCode: "CARD-PAYMENT",
      subCode: "TRANSFER-IN",
      code: "TRANSFER-OUT",
      description: "Other",
    };
    expect(pkoLabel(operation(all))?.key).toBe("CARD-PAYMENT");
    expect(pkoLabel(operation({ ...all, remittanceCode: null }))?.key).toBe(
      "TRANSFER-IN",
    );
    expect(
      pkoLabel(operation({ ...all, remittanceCode: null, subCode: null }))?.key,
    ).toBe("TRANSFER-OUT");
    expect(
      pkoLabel(
        operation({
          ...all,
          remittanceCode: null,
          subCode: null,
          code: null,
        }),
      )?.key,
    ).toBe("Other");
  });

  it("makes no tag of text that is not plain, rather than a mangled one", () => {
    for (const hostile of [
      "<script>x</script>",
      "a\u0000b",
      "-leading",
      "x".repeat(101),
      "emoji \u{1F600}",
    ]) {
      expect(pkoLabel(operation({ code: hostile }))).toBeNull();
    }
  });

  it("accepts a name of exactly the tag width", () => {
    const name = "a".repeat(100);
    expect(pkoLabel(operation({ code: name }))).toEqual({
      key: name,
      label: name,
    });
  });
});
