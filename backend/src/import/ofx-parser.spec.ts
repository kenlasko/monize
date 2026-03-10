import { validateOfxContent, parseOfx } from "./ofx-parser";

describe("OFX Parser", () => {
  describe("validateOfxContent", () => {
    it("returns invalid for empty content", () => {
      expect(validateOfxContent("")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for whitespace-only content", () => {
      expect(validateOfxContent("   \n  ")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for content without OFX tag", () => {
      expect(validateOfxContent("random text without OFX markers")).toEqual({
        valid: false,
        error: "Not a valid OFX file: missing <OFX> tag",
      });
    });

    it("returns invalid when OFX tag present but no bank or credit card statement", () => {
      const content = `OFXHEADER:100
<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0</CODE></STATUS>
</SONRS>
</SIGNONMSGSRSV1>
</OFX>`;
      expect(validateOfxContent(content)).toEqual({
        valid: false,
        error:
          "Not a supported OFX file: no bank or credit card statement found. Investment OFX files are not supported.",
      });
    });

    it("returns valid for content with BANKMSGSRSV1", () => {
      const content = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Grocery Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      expect(validateOfxContent(content)).toEqual({ valid: true });
    });

    it("returns valid for content with CREDITCARDMSGSRSV1", () => {
      const content = `<OFX>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-25.00
<NAME>Coffee Shop
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;
      expect(validateOfxContent(content)).toEqual({ valid: true });
    });
  });

  describe("parseOfx - basic bank statement", () => {
    it("parses a bank statement with multiple transactions", () => {
      const ofx = `OFXHEADER:100
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKACCTFROM>
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Grocery Store
<MEMO>Weekly groceries
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260116
<TRNAMT>2500.00
<NAME>Employer Inc
</STMTTRN>
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260117
<TRNAMT>-200.00
<NAME>Landlord
<CHECKNUM>1234
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);

      expect(result.transactions).toHaveLength(3);
      expect(result.accountType).toBe("CHEQUING");

      const tx0 = result.transactions[0];
      expect(tx0.date).toBe("2026-01-15");
      expect(tx0.amount).toBe(-50.0);
      expect(tx0.payee).toBe("Grocery Store");
      expect(tx0.memo).toBe("Weekly groceries");
      expect(tx0.isTransfer).toBe(false);
      expect(tx0.cleared).toBe(true);
      expect(tx0.reconciled).toBe(false);

      const tx1 = result.transactions[1];
      expect(tx1.date).toBe("2026-01-16");
      expect(tx1.amount).toBe(2500.0);
      expect(tx1.payee).toBe("Employer Inc");

      const tx2 = result.transactions[2];
      expect(tx2.date).toBe("2026-01-17");
      expect(tx2.amount).toBe(-200.0);
      expect(tx2.payee).toBe("Landlord");
      expect(tx2.number).toBe("1234");
    });
  });

  describe("parseOfx - credit card statement", () => {
    it("detects credit card account type from CREDITCARDMSGSRSV1", () => {
      const ofx = `<OFX>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-25.00
<NAME>Coffee Shop
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.accountType).toBe("CREDIT_CARD");
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(-25.0);
    });
  });

  describe("parseOfx - date parsing", () => {
    function buildOfxWithDate(dateStr: string): string {
      return `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>${dateStr}
<TRNAMT>-10.00
<NAME>Test
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    }

    it("parses YYYYMMDD format", () => {
      const result = parseOfx(buildOfxWithDate("20260315"));
      expect(result.transactions[0].date).toBe("2026-03-15");
    });

    it("parses YYYYMMDDHHMMSS format", () => {
      const result = parseOfx(buildOfxWithDate("20260315120000"));
      expect(result.transactions[0].date).toBe("2026-03-15");
    });

    it("parses YYYYMMDDHHMMSS with timezone info", () => {
      const result = parseOfx(buildOfxWithDate("20260315120000[-5:EST]"));
      expect(result.transactions[0].date).toBe("2026-03-15");
    });

    it("parses YYYYMMDDHHMMSS with fractional seconds and timezone", () => {
      const result = parseOfx(buildOfxWithDate("20260315120000.000[-5:EST]"));
      expect(result.transactions[0].date).toBe("2026-03-15");
    });

    it("skips transactions with invalid date strings", () => {
      const result = parseOfx(buildOfxWithDate("abc"));
      expect(result.transactions).toHaveLength(0);
    });

    it("skips transactions with date shorter than 8 characters", () => {
      const result = parseOfx(buildOfxWithDate("202601"));
      expect(result.transactions).toHaveLength(0);
    });

    it("skips transactions with invalid month in date", () => {
      const result = parseOfx(buildOfxWithDate("20261315"));
      expect(result.transactions).toHaveLength(0);
    });

    it("skips transactions with invalid day in date", () => {
      const result = parseOfx(buildOfxWithDate("20260132"));
      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("parseOfx - TRNTYPE mapping", () => {
    function buildOfxWithType(trnType: string): string {
      return `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>${trnType}
<DTPOSTED>20260115
<TRNAMT>-10.00
<NAME>Test Payee
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    }

    it("marks DEBIT transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("DEBIT"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });

    it("marks CREDIT transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("CREDIT"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });

    it("marks CHECK transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("CHECK"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });

    it("marks DEP transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("DEP"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });

    it("marks ATM transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("ATM"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });

    it("marks POS transactions as non-transfer", () => {
      const result = parseOfx(buildOfxWithType("POS"));
      expect(result.transactions[0].isTransfer).toBe(false);
    });
  });

  describe("parseOfx - transfer detection", () => {
    it("detects XFER type as transfer", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>XFER
<DTPOSTED>20260115
<TRNAMT>-500.00
<NAME>Savings Account
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      const tx = result.transactions[0];
      expect(tx.isTransfer).toBe(true);
      expect(tx.transferAccount).toBe("Savings Account");
    });

    it("collects unique transfer account names", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>XFER
<DTPOSTED>20260115
<TRNAMT>-500.00
<NAME>Savings Account
</STMTTRN>
<STMTTRN>
<TRNTYPE>XFER
<DTPOSTED>20260116
<TRNAMT>-200.00
<NAME>Investment Account
</STMTTRN>
<STMTTRN>
<TRNTYPE>XFER
<DTPOSTED>20260117
<TRNAMT>300.00
<NAME>Savings Account
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transferAccounts).toHaveLength(2);
      expect(result.transferAccounts).toContain("Savings Account");
      expect(result.transferAccounts).toContain("Investment Account");
    });

    it("does not set transferAccount for non-XFER types", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].transferAccount).toBe("");
      expect(result.transferAccounts).toHaveLength(0);
    });
  });

  describe("parseOfx - missing fields handling", () => {
    it("uses memo as payee when name is missing", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-30.00
<MEMO>ATM Withdrawal
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].payee).toBe("ATM Withdrawal");
      expect(result.transactions[0].memo).toBe("");
    });

    it("sets empty memo when name and memo are the same", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-30.00
<NAME>Grocery Store
<MEMO>Grocery Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].payee).toBe("Grocery Store");
      expect(result.transactions[0].memo).toBe("");
    });

    it("includes memo when different from name", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-30.00
<NAME>Grocery Store
<MEMO>Weekly shopping trip
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].payee).toBe("Grocery Store");
      expect(result.transactions[0].memo).toBe("Weekly shopping trip");
    });

    it("skips transactions with missing amount", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<NAME>No Amount
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260116
<TRNAMT>-10.00
<NAME>Valid Transaction
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].payee).toBe("Valid Transaction");
    });

    it("sets empty payee when both name and memo are missing", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].payee).toBe("");
    });

    it("sets empty check number when CHECKNUM is missing", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].number).toBe("");
    });
  });

  describe("parseOfx - amount parsing", () => {
    function buildOfxWithAmount(amount: string): string {
      return `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>${amount}
<NAME>Test
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    }

    it("parses negative amounts", () => {
      const result = parseOfx(buildOfxWithAmount("-1234.56"));
      expect(result.transactions[0].amount).toBe(-1234.56);
    });

    it("parses positive amounts", () => {
      const result = parseOfx(buildOfxWithAmount("2500.00"));
      expect(result.transactions[0].amount).toBe(2500.0);
    });

    it("parses zero amounts", () => {
      const result = parseOfx(buildOfxWithAmount("0.00"));
      expect(result.transactions[0].amount).toBe(0);
    });

    it("rounds amounts to 4 decimal places", () => {
      const result = parseOfx(buildOfxWithAmount("-50.12346"));
      expect(result.transactions[0].amount).toBe(-50.1235);
    });

    it("handles amounts with many decimal places", () => {
      const result = parseOfx(buildOfxWithAmount("100.99999"));
      expect(result.transactions[0].amount).toBe(101.0);
    });

    it("skips transactions with non-numeric amounts", () => {
      const result = parseOfx(buildOfxWithAmount("abc"));
      expect(result.transactions).toHaveLength(0);
    });
  });

  describe("parseOfx - account type detection", () => {
    function buildOfxWithAcctType(acctType: string): string {
      return `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKACCTFROM>
<ACCTTYPE>${acctType}
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-10.00
<NAME>Test
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
    }

    it("maps CHECKING to CHEQUING", () => {
      const result = parseOfx(buildOfxWithAcctType("CHECKING"));
      expect(result.accountType).toBe("CHEQUING");
    });

    it("maps SAVINGS to SAVINGS", () => {
      const result = parseOfx(buildOfxWithAcctType("SAVINGS"));
      expect(result.accountType).toBe("SAVINGS");
    });

    it("maps CREDITLINE to LINE_OF_CREDIT", () => {
      const result = parseOfx(buildOfxWithAcctType("CREDITLINE"));
      expect(result.accountType).toBe("LINE_OF_CREDIT");
    });

    it("maps MONEYMRKT to SAVINGS", () => {
      const result = parseOfx(buildOfxWithAcctType("MONEYMRKT"));
      expect(result.accountType).toBe("SAVINGS");
    });

    it("defaults unknown account types to CHEQUING", () => {
      const result = parseOfx(buildOfxWithAcctType("UNKNOWN"));
      expect(result.accountType).toBe("CHEQUING");
    });

    it("defaults to CHEQUING when ACCTTYPE tag is missing in bank statement", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-10.00
<NAME>Test
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.accountType).toBe("CHEQUING");
    });
  });

  describe("parseOfx - sanitization", () => {
    it("strips HTML angle brackets from payee name", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME><script>alert(1)</script>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].payee).not.toContain("<");
      expect(result.transactions[0].payee).not.toContain(">");
    });

    it("strips HTML angle brackets from memo", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Store
<MEMO><img src=x onerror=alert(1)>
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].memo).not.toContain("<");
      expect(result.transactions[0].memo).not.toContain(">");
    });

    it("strips HTML angle brackets from transfer account name", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>XFER
<DTPOSTED>20260115
<TRNAMT>-500.00
<NAME>Savings &amp; Loans
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].isTransfer).toBe(true);
      expect(result.transactions[0].transferAccount).not.toContain("<");
      expect(result.transactions[0].transferAccount).not.toContain(">");
      // The NAME value does not contain angle brackets so it passes through intact
      expect(result.transactions[0].transferAccount).toBe(
        "Savings &amp; Loans",
      );
    });
  });

  describe("parseOfx - empty transaction blocks", () => {
    it("skips empty STMTTRN blocks", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Valid Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].payee).toBe("Valid Store");
    });

    it("returns empty result when no valid transactions exist", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions).toHaveLength(0);
      expect(result.transferAccounts).toHaveLength(0);
      expect(result.categories).toHaveLength(0);
      expect(result.securities).toHaveLength(0);
    });
  });

  describe("parseOfx - result metadata", () => {
    it("returns correct metadata fields", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.detectedDateFormat).toBe("YYYY-MM-DD");
      expect(result.accountName).toBe("");
      expect(result.openingBalance).toBeNull();
      expect(result.openingBalanceDate).toBeNull();
    });

    it("collects up to 3 sample dates", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-10.00
<NAME>A
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260116
<TRNAMT>-20.00
<NAME>B
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260117
<TRNAMT>-30.00
<NAME>C
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260118
<TRNAMT>-40.00
<NAME>D
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      expect(result.sampleDates).toHaveLength(3);
      expect(result.sampleDates).toEqual(["20260115", "20260116", "20260117"]);
    });

    it("sets transaction default fields correctly", () => {
      const ofx = `<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115
<TRNAMT>-50.00
<NAME>Store
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;
      const result = parseOfx(ofx);
      const tx = result.transactions[0];
      expect(tx.category).toBe("");
      expect(tx.splits).toEqual([]);
      expect(tx.security).toBe("");
      expect(tx.action).toBe("");
      expect(tx.price).toBe(0);
      expect(tx.quantity).toBe(0);
      expect(tx.commission).toBe(0);
    });
  });
});
