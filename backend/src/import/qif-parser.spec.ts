import { parseQif, validateQifContent } from "./qif-parser";

describe("QIF Parser", () => {
  describe("validateQifContent", () => {
    it("returns invalid for empty content", () => {
      expect(validateQifContent("")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for whitespace-only content", () => {
      expect(validateQifContent("   \n  ")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for content without QIF markers", () => {
      expect(validateQifContent("random text without markers")).toEqual({
        valid: false,
        error: "Invalid QIF format: no transaction markers found",
      });
    });

    it("returns valid for content with !Type: header", () => {
      expect(validateQifContent("!Type:Bank\nD01/15/2026\n^")).toEqual({
        valid: true,
      });
    });

    it("returns valid for content with !Account header", () => {
      expect(validateQifContent("!Account\nNChecking\n^")).toEqual({
        valid: true,
      });
    });

    it("returns valid for content with ^ markers but no headers", () => {
      expect(validateQifContent("D01/15/2026\nT-50.00\n^")).toEqual({
        valid: true,
      });
    });
  });

  describe("parseQif - account type detection", () => {
    it("detects Bank type as CHEQUING", () => {
      const result = parseQif("!Type:Bank\nD01/15/2026\nT-50.00\n^");
      expect(result.accountType).toBe("CHEQUING");
    });

    it("detects CCard type as CREDIT_CARD", () => {
      const result = parseQif("!Type:CCard\nD01/15/2026\nT-50.00\n^");
      expect(result.accountType).toBe("CREDIT_CARD");
    });

    it("detects Cash type as CASH", () => {
      const result = parseQif("!Type:Cash\nD01/15/2026\nT-50.00\n^");
      expect(result.accountType).toBe("CASH");
    });

    it("detects Invst type as INVESTMENT", () => {
      const result = parseQif(
        "!Type:Invst\nD01/15/2026\nNBuy\nYAAPL\nI150.00\nQ10\nT-1500.00\n^",
      );
      expect(result.accountType).toBe("INVESTMENT");
    });

    it("detects Oth A type as ASSET", () => {
      const result = parseQif("!Type:Oth A\nD01/15/2026\nT1000.00\n^");
      expect(result.accountType).toBe("ASSET");
    });

    it("detects Oth L type as LINE_OF_CREDIT", () => {
      const result = parseQif("!Type:Oth L\nD01/15/2026\nT-1000.00\n^");
      expect(result.accountType).toBe("LINE_OF_CREDIT");
    });

    it("defaults unknown types to OTHER", () => {
      const result = parseQif("!Type:Unknown\nD01/15/2026\nT-50.00\n^");
      expect(result.accountType).toBe("OTHER");
    });
  });

  describe("parseQif - basic bank transactions", () => {
    it("parses a simple transaction", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PGrocery Store
MGrocery shopping
LFood:Groceries
^`;
      const result = parseQif(qif);

      expect(result.transactions).toHaveLength(1);
      const tx = result.transactions[0];
      expect(tx.amount).toBe(-50.0);
      expect(tx.payee).toBe("Grocery Store");
      expect(tx.memo).toBe("Grocery shopping");
      expect(tx.category).toBe("Food:Groceries");
      expect(tx.isTransfer).toBe(false);
    });

    it("parses multiple transactions", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PGrocery Store
^
D01/16/2026
T2500.00
PEmployer
^`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0].amount).toBe(-50.0);
      expect(result.transactions[1].amount).toBe(2500.0);
    });

    it("extracts unique categories sorted", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
LFood:Groceries
^
D01/16/2026
T-30.00
LTransport
^
D01/17/2026
T-20.00
LFood:Groceries
^`;
      const result = parseQif(qif);
      expect(result.categories).toEqual(["Food:Groceries", "Transport"]);
    });

    it("parses cleared and reconciled status", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
C*
^
D01/16/2026
T-30.00
CX
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].cleared).toBe(true);
      expect(result.transactions[0].reconciled).toBe(false);
      expect(result.transactions[1].cleared).toBe(false);
      expect(result.transactions[1].reconciled).toBe(true);
    });

    it("parses cheque number", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
N1234
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].number).toBe("1234");
    });
  });

  describe("parseQif - transfers", () => {
    it("detects transfer category pattern", () => {
      const qif = `!Type:Bank
D01/15/2026
T-500.00
L[Savings Account]
^`;
      const result = parseQif(qif);
      const tx = result.transactions[0];
      expect(tx.isTransfer).toBe(true);
      expect(tx.transferAccount).toBe("Savings Account");
      expect(tx.category).toBe("");
    });

    it("collects unique transfer accounts", () => {
      const qif = `!Type:Bank
D01/15/2026
T-500.00
L[Savings]
^
D01/16/2026
T-200.00
L[Checking]
^
D01/17/2026
T-100.00
L[Savings]
^`;
      const result = parseQif(qif);
      expect(result.transferAccounts).toEqual(["Checking", "Savings"]);
    });
  });

  describe("parseQif - split transactions", () => {
    it("parses split categories and amounts", () => {
      const qif = `!Type:Bank
D01/15/2026
T-100.00
PMulti Store
SFood:Groceries
EGrocery items
$-60.00
SHousehold
ECleaning supplies
$-40.00
^`;
      const result = parseQif(qif);
      const tx = result.transactions[0];
      expect(tx.splits).toHaveLength(2);
      expect(tx.splits[0].category).toBe("Food:Groceries");
      expect(tx.splits[0].amount).toBe(-60.0);
      expect(tx.splits[0].memo).toBe("Grocery items");
      expect(tx.splits[1].category).toBe("Household");
      expect(tx.splits[1].amount).toBe(-40.0);
    });

    it("handles transfer splits", () => {
      const qif = `!Type:Bank
D01/15/2026
T-100.00
S[Savings]
$-100.00
^`;
      const result = parseQif(qif);
      const split = result.transactions[0].splits[0];
      expect(split.isTransfer).toBe(true);
      expect(split.transferAccount).toBe("Savings");
    });
  });

  describe("parseQif - investment transactions", () => {
    it("parses Buy transaction", () => {
      const qif = `!Type:Invst
D01/15/2026
NBuy
YAAPL
I150.00
Q10
O9.99
T-1509.99
^`;
      const result = parseQif(qif);
      const tx = result.transactions[0];
      expect(tx.action).toBe("Buy");
      expect(tx.security).toBe("AAPL");
      expect(tx.price).toBe(150.0);
      expect(tx.quantity).toBe(10);
      expect(tx.commission).toBe(9.99);
    });

    it("collects unique securities sorted", () => {
      const qif = `!Type:Invst
D01/15/2026
NBuy
YMSFT
I300.00
Q5
T-1500.00
^
D01/16/2026
NBuy
YAAPL
I150.00
Q10
T-1500.00
^
D01/17/2026
NDiv
YMSFT
T50.00
^`;
      const result = parseQif(qif);
      expect(result.securities).toEqual(["AAPL", "MSFT"]);
    });
  });

  describe("parseQif - opening balance", () => {
    it("extracts opening balance and excludes it from transactions", () => {
      const qif = `!Type:Bank
D01/01/2026
T1000.00
POpening Balance
L[Checking]
^
D01/15/2026
T-50.00
PGrocery Store
^`;
      const result = parseQif(qif);
      expect(result.openingBalance).toBe(1000.0);
      expect(result.openingBalanceDate).toBeDefined();
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].payee).toBe("Grocery Store");
    });
  });

  describe("parseQif - date format detection", () => {
    it("detects MM/DD/YYYY when day > 12", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
^`;
      const result = parseQif(qif);
      expect(result.detectedDateFormat).toBe("MM/DD/YYYY");
    });

    it("detects DD/MM/YYYY when first part > 12", () => {
      const qif = `!Type:Bank
D15/01/2026
T-50.00
^`;
      const result = parseQif(qif);
      expect(result.detectedDateFormat).toBe("DD/MM/YYYY");
    });

    it("detects YYYY-MM-DD format", () => {
      const qif = `!Type:Bank
D2026-01-15
T-50.00
^`;
      const result = parseQif(qif);
      expect(result.detectedDateFormat).toBe("YYYY-MM-DD");
    });

    it("returns sample dates", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
^
D01/16/2026
T-30.00
^`;
      const result = parseQif(qif);
      expect(result.sampleDates.length).toBeGreaterThan(0);
      expect(result.sampleDates.length).toBeLessThanOrEqual(3);
    });
  });

  describe("parseQif - date parsing with explicit format", () => {
    it("parses MM/DD/YYYY format", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });

    it("parses DD/MM/YYYY format", () => {
      const qif = `!Type:Bank
D15/01/2026
T-50.00
^`;
      const result = parseQif(qif, "DD/MM/YYYY");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });

    it("parses YYYY-MM-DD format", () => {
      const qif = `!Type:Bank
D2026-01-15
T-50.00
^`;
      const result = parseQif(qif, "YYYY-MM-DD");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });

    it("handles 2-digit year (>50 = 19xx)", () => {
      const qif = `!Type:Bank
D01/15/99
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("1999-01-15");
    });

    it("handles 2-digit year (<=50 = 20xx)", () => {
      const qif = `!Type:Bank
D01/15/26
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });
  });

  describe("parseQif - amount parsing", () => {
    it("handles negative amounts", () => {
      const qif = `!Type:Bank
D01/15/2026
T-1,234.56
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].amount).toBe(-1234.56);
    });

    it("handles amounts with currency symbols", () => {
      const qif = `!Type:Bank
D01/15/2026
T$1,234.56
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].amount).toBe(1234.56);
    });

    it("handles zero amounts", () => {
      const qif = `!Type:Bank
D01/15/2026
T0.00
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].amount).toBe(0);
    });
  });

  describe("parseQif - edge cases", () => {
    it("handles file without trailing ^", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PGrocery Store`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(1);
    });

    it("handles Windows-style line endings (CRLF)", () => {
      const qif = "!Type:Bank\r\nD01/15/2026\r\nT-50.00\r\n^\r\n";
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(1);
    });

    it("skips empty lines", () => {
      const qif = `!Type:Bank

D01/15/2026

T-50.00

^`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(1);
    });

    it("handles U field as alternative amount", () => {
      const qif = `!Type:Bank
D01/15/2026
U-75.00
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].amount).toBe(-75.0);
    });
  });

  describe("parseQif - ambiguous date format (all parts <= 12)", () => {
    it("defaults to MM/DD/YYYY when both parts are <= 12 and no format specified", () => {
      const qif = `!Type:Bank
D01/02/2026
T-50.00
^
D03/04/2026
T-30.00
^`;
      const result = parseQif(qif);
      // Both 01 and 02 are <= 12, so detection cannot disambiguate
      // Default should be MM/DD/YYYY
      expect(result.detectedDateFormat).toBe("MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2026-01-02");
      expect(result.transactions[1].date).toBe("2026-03-04");
    });

    it("parses ambiguous dates as DD/MM/YYYY when explicit format provided", () => {
      const qif = `!Type:Bank
D01/02/2026
T-50.00
^`;
      const result = parseQif(qif, "DD/MM/YYYY");
      // With DD/MM/YYYY, 01 is day and 02 is month
      expect(result.transactions[0].date).toBe("2026-02-01");
    });

    it("defaults to YYYY-MM-DD for ISO format when both parts are <= 12", () => {
      const qif = `!Type:Bank
D2026-03-05
T-50.00
^
D2026-06-07
T-20.00
^`;
      const result = parseQif(qif);
      // Both month and day <= 12, defaults to YYYY-MM-DD
      expect(result.detectedDateFormat).toBe("YYYY-MM-DD");
      expect(result.transactions[0].date).toBe("2026-03-05");
    });

    it("detects YYYY-DD-MM when second part > 12 in ISO format", () => {
      const qif = `!Type:Bank
D2026-15-01
T-50.00
^`;
      const result = parseQif(qif);
      expect(result.detectedDateFormat).toBe("YYYY-DD-MM");
    });

    it("disambiguates using later dates when first date is ambiguous", () => {
      const qif = `!Type:Bank
D01/02/2026
T-50.00
^
D01/15/2026
T-30.00
^`;
      const result = parseQif(qif);
      // Second date has 15 in the day position, so it must be MM/DD/YYYY
      expect(result.detectedDateFormat).toBe("MM/DD/YYYY");
    });
  });

  describe("parseQif - M/D'YY format with apostrophe separator", () => {
    it("parses date with apostrophe before 2-digit year (M/D'YY)", () => {
      const qif = `!Type:Bank
D1/15'26
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });

    it("parses date with apostrophe and year > 50 as 19xx", () => {
      const qif = `!Type:Bank
D3/20'97
T-100.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("1997-03-20");
    });

    it("parses apostrophe format with DD/MM/YYYY format", () => {
      const qif = `!Type:Bank
D15/3'26
T-50.00
^`;
      const result = parseQif(qif, "DD/MM/YYYY");
      expect(result.transactions[0].date).toBe("2026-03-15");
    });
  });

  describe("parseQif - 2-digit year boundary (year 49 vs 50)", () => {
    it("treats year 50 as 2050", () => {
      const qif = `!Type:Bank
D01/15/50
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2050-01-15");
    });

    it("treats year 51 as 1951", () => {
      const qif = `!Type:Bank
D01/15/51
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("1951-01-15");
    });

    it("treats year 49 as 2049", () => {
      const qif = `!Type:Bank
D01/15/49
T-50.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2049-01-15");
    });

    it("treats year 00 as 2000", () => {
      const qif = `!Type:Bank
D06/15/00
T-25.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("2000-06-15");
    });

    it("treats year 99 as 1999", () => {
      const qif = `!Type:Bank
D12/31/99
T-75.00
^`;
      const result = parseQif(qif, "MM/DD/YYYY");
      expect(result.transactions[0].date).toBe("1999-12-31");
    });
  });

  describe("parseQif - EOF handling without ^ terminator", () => {
    it("captures transaction data when file ends without ^", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PGrocery Store
MGroceries
LFood`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].payee).toBe("Grocery Store");
      expect(result.transactions[0].memo).toBe("Groceries");
      expect(result.transactions[0].category).toBe("Food");
      expect(result.transactions[0].amount).toBe(-50);
    });

    it("captures splits when file ends without ^", () => {
      const qif = `!Type:Bank
D01/15/2026
T-100.00
SFood
EGroceries
$-60.00
STransport
EBus fare
$-40.00`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].splits).toHaveLength(2);
      expect(result.transactions[0].splits[0].category).toBe("Food");
      expect(result.transactions[0].splits[0].amount).toBe(-60);
      expect(result.transactions[0].splits[1].category).toBe("Transport");
      expect(result.transactions[0].splits[1].amount).toBe(-40);
    });

    it("handles multiple transactions where only the last lacks ^", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PStore A
^
D01/16/2026
T-30.00
PStore B`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(2);
      expect(result.transactions[0].payee).toBe("Store A");
      expect(result.transactions[1].payee).toBe("Store B");
    });

    it("does not create transaction for incomplete record without date at EOF", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
^
T-30.00
PNo Date`;
      const result = parseQif(qif);
      // The second record has no date (T comes before D), so currentTransaction
      // is null when T is encountered. Only the first transaction should be captured.
      expect(result.transactions).toHaveLength(1);
    });
  });

  describe("parseQif - account name extraction from !Account headers", () => {
    it("handles !Account header without crashing", () => {
      const qif = `!Account
NChecking Account
TBank
^
!Type:Bank
D01/15/2026
T-50.00
^`;
      const result = parseQif(qif);
      // The parser skips !Account and N lines within account header
      // but still parses the subsequent transactions
      expect(result.transactions).toHaveLength(1);
      expect(result.accountType).toBe("CHEQUING");
    });

    it("continues parsing after !Account section", () => {
      const qif = `!Account
NMy Savings
TCash
^
!Type:Cash
D03/01/2026
T100.00
PDeposit
^
D03/02/2026
T-20.00
PWithdrawal
^`;
      const result = parseQif(qif);
      expect(result.transactions).toHaveLength(2);
      expect(result.accountType).toBe("CASH");
    });
  });

  describe("parseQif - YYYY-DD-MM with explicit format", () => {
    it("parses YYYY-DD-MM format when specified", () => {
      const qif = `!Type:Bank
D2026-15-01
T-50.00
^`;
      const result = parseQif(qif, "YYYY-DD-MM");
      expect(result.transactions[0].date).toBe("2026-01-15");
    });
  });

  describe("parseQif - lowercase reconciled status", () => {
    it("handles lowercase x as reconciled", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
Cx
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].reconciled).toBe(true);
      expect(result.transactions[0].cleared).toBe(false);
    });
  });

  describe("parseQif - unparseable date returns as-is", () => {
    it("returns unparseable date string as-is", () => {
      const qif = `!Type:Bank
DJanuary 15, 2026
T-50.00
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].date).toBe("January 15, 2026");
    });
  });

  describe("parseQif - date detection with multiple ambiguous ISO dates", () => {
    it("checks later ISO dates to disambiguate format", () => {
      const qif = `!Type:Bank
D2026-01-02
T-50.00
^
D2026-01-03
T-30.00
^
D2026-01-15
T-20.00
^`;
      const result = parseQif(qif);
      // Third date has 15 as the third part, which > 12, confirming YYYY-MM-DD
      expect(result.detectedDateFormat).toBe("YYYY-MM-DD");
    });
  });

  describe("HTML sanitization", () => {
    it("strips HTML angle brackets from payee", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
P<script>alert(1)</script>
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].payee).toBe("scriptalert(1)/script");
    });

    it("strips HTML angle brackets from memo", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PGrocery
M<img src=x onerror=alert(1)>
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].memo).toBe("img src=x onerror=alert(1)");
    });

    it("strips HTML angle brackets from category", () => {
      const qif = `!Type:Bank
D01/15/2026
T-50.00
PStore
L<b>Food</b>
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].category).toBe("bFood/b");
    });

    it("strips HTML angle brackets from split memo", () => {
      const qif = `!Type:Bank
D01/15/2026
T-100.00
PStore
SFood
E<script>xss</script>
$-60.00
SClothing
E<b>memo</b>
$-40.00
^`;
      const result = parseQif(qif);
      expect(result.transactions[0].splits[0].memo).toBe("scriptxss/script");
      expect(result.transactions[0].splits[1].memo).toBe("bmemo/b");
    });
  });
});
