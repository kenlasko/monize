import {
  validateCsvContent,
  parseCsvHeaders,
  parseCsv,
  CsvColumnMappingConfig,
  CsvTransferRule,
} from "./csv-parser";

describe("CSV Parser", () => {
  describe("validateCsvContent", () => {
    it("returns invalid for empty content", () => {
      expect(validateCsvContent("")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for whitespace-only content", () => {
      expect(validateCsvContent("   \n  ")).toEqual({
        valid: false,
        error: "File is empty",
      });
    });

    it("returns invalid for a single line", () => {
      expect(validateCsvContent("Date,Amount,Payee")).toEqual({
        valid: false,
        error:
          "CSV file must have at least 2 rows (header and data, or 2 data rows)",
      });
    });

    it("returns valid for content with at least 2 non-empty lines", () => {
      expect(
        validateCsvContent("Date,Amount,Payee\n01/15/2026,-50.00,Grocery"),
      ).toEqual({ valid: true });
    });

    it("returns valid for 2 data rows without a header", () => {
      expect(
        validateCsvContent("01/15/2026,-50.00\n01/16/2026,-30.00"),
      ).toEqual({ valid: true });
    });
  });

  describe("parseCsvHeaders", () => {
    it("parses headers with comma delimiter", () => {
      const csv = "Date,Amount,Payee\n01/15/2026,-50.00,Grocery\n";
      const result = parseCsvHeaders(csv, ",");
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(result.sampleRows).toHaveLength(1);
      expect(result.rowCount).toBe(1);
    });

    it("parses headers with semicolon delimiter", () => {
      const csv = "Date;Amount;Payee\n01/15/2026;-50.00;Grocery\n";
      const result = parseCsvHeaders(csv, ";");
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(result.sampleRows).toHaveLength(1);
    });

    it("parses headers with tab delimiter", () => {
      const csv = "Date\tAmount\tPayee\n01/15/2026\t-50.00\tGrocery\n";
      const result = parseCsvHeaders(csv, "\t");
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(result.sampleRows).toHaveLength(1);
    });

    it("auto-detects comma delimiter", () => {
      const csv =
        "Date,Amount,Payee\n01/15/2026,-50.00,Grocery\n01/16/2026,-30.00,Store\n";
      const result = parseCsvHeaders(csv);
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
      expect(result.rowCount).toBe(2);
    });

    it("auto-detects semicolon delimiter", () => {
      const csv =
        "Date;Amount;Payee\n01/15/2026;-50.00;Grocery\n01/16/2026;-30.00;Store\n";
      const result = parseCsvHeaders(csv);
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
    });

    it("auto-detects tab delimiter", () => {
      const csv =
        "Date\tAmount\tPayee\n01/15/2026\t-50.00\tGrocery\n01/16/2026\t-30.00\tStore\n";
      const result = parseCsvHeaders(csv);
      expect(result.headers).toEqual(["Date", "Amount", "Payee"]);
    });

    it("returns up to 5 sample rows", () => {
      const lines = ["H1,H2"];
      for (let i = 0; i < 10; i++) {
        lines.push(`a${i},b${i}`);
      }
      const result = parseCsvHeaders(lines.join("\n"));
      expect(result.sampleRows).toHaveLength(5);
      expect(result.rowCount).toBe(10);
    });

    it("returns empty results for empty content", () => {
      const result = parseCsvHeaders("");
      expect(result.headers).toEqual([]);
      expect(result.sampleRows).toEqual([]);
      expect(result.rowCount).toBe(0);
    });
  });

  describe("parseCsv", () => {
    function baseConfig(
      overrides?: Partial<CsvColumnMappingConfig>,
    ): CsvColumnMappingConfig {
      return {
        date: 0,
        amount: 1,
        payee: 2,
        dateFormat: "MM/DD/YYYY",
        hasHeader: true,
        delimiter: ",",
        ...overrides,
      };
    }

    describe("basic parsing", () => {
      it("parses a basic CSV with comma delimiter", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-50.00,Grocery Store\n01/16/2026,2500.00,Employer\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].date).toBe("2026-01-15");
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[0].payee).toBe("Grocery Store");
        expect(result.transactions[1].date).toBe("2026-01-16");
        expect(result.transactions[1].amount).toBe(2500);
        expect(result.transactions[1].payee).toBe("Employer");
      });

      it("parses CSV with semicolon delimiter", () => {
        const csv = "Date;Amount;Payee\n01/15/2026;-50.00;Grocery Store\n";
        const result = parseCsv(csv, baseConfig({ delimiter: ";" }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[0].payee).toBe("Grocery Store");
      });

      it("parses CSV with tab delimiter", () => {
        const csv = "Date\tAmount\tPayee\n01/15/2026\t-50.00\tGrocery Store\n";
        const result = parseCsv(csv, baseConfig({ delimiter: "\t" }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[0].payee).toBe("Grocery Store");
      });

      it("parses CSV without header row", () => {
        const csv = "01/15/2026,-50.00,Grocery Store\n";
        const result = parseCsv(csv, baseConfig({ hasHeader: false }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[0].payee).toBe("Grocery Store");
      });

      it("returns empty result for empty content", () => {
        const result = parseCsv("", baseConfig());
        expect(result.transactions).toEqual([]);
        expect(result.categories).toEqual([]);
        expect(result.transferAccounts).toEqual([]);
        expect(result.accountType).toBe("CHEQUING");
        expect(result.openingBalance).toBeNull();
        expect(result.openingBalanceDate).toBeNull();
      });
    });

    describe("amount columns", () => {
      it("uses single amount column", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-75.50,Store\n01/16/2026,100.00,Deposit\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(-75.5);
        expect(result.transactions[1].amount).toBe(100);
      });

      it("uses separate debit and credit columns", () => {
        const csv =
          "Date,Debit,Credit,Payee\n01/15/2026,50.00,,Store\n01/16/2026,,100.00,Deposit\n";
        const config = baseConfig({
          amount: undefined,
          debit: 1,
          credit: 2,
          payee: 3,
        });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[1].amount).toBe(100);
      });

      it("negates debit values regardless of sign", () => {
        const csv =
          "Date,Debit,Credit\n01/15/2026,-50.00,\n01/16/2026,75.00,\n";
        const config = baseConfig({
          amount: undefined,
          debit: 1,
          credit: 2,
        });
        const result = parseCsv(csv, config);

        // Both should be negative since debits are outflows
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[1].amount).toBe(-75);
      });

      it("treats credit as positive regardless of sign", () => {
        const csv = "Date,Debit,Credit\n01/15/2026,,200.00\n";
        const config = baseConfig({
          amount: undefined,
          debit: 1,
          credit: 2,
        });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].amount).toBe(200);
      });

      it("reverses sign for single amount column when reverseSign is true", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,75.50,Store\n01/16/2026,-100.00,Refund\n";
        const config = baseConfig({ reverseSign: true });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].amount).toBe(-75.5);
        expect(result.transactions[1].amount).toBe(100);
      });

      it("does not reverse sign when reverseSign is false", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,75.50,Store\n";
        const config = baseConfig({ reverseSign: false });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].amount).toBe(75.5);
      });

      it("does not reverse sign for split debit/credit columns", () => {
        const csv =
          "Date,Debit,Credit,Payee\n01/15/2026,50.00,,Store\n01/16/2026,,100.00,Deposit\n";
        const config = baseConfig({
          amount: undefined,
          debit: 1,
          credit: 2,
          payee: 3,
          reverseSign: true,
        });
        const result = parseCsv(csv, config);

        // reverseSign only applies to single amount mode
        expect(result.transactions[0].amount).toBe(-50);
        expect(result.transactions[1].amount).toBe(100);
      });
    });

    describe("date format parsing", () => {
      it("parses MM/DD/YYYY format", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "MM/DD/YYYY" }));
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("parses DD/MM/YYYY format", () => {
        const csv = "Date,Amount\n15/01/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "DD/MM/YYYY" }));
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("parses YYYY-MM-DD format", () => {
        const csv = "Date,Amount\n2026-01-15,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "YYYY-MM-DD" }));
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("parses YYYY-DD-MM format", () => {
        const csv = "Date,Amount\n2026-15-01,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "YYYY-DD-MM" }));
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("handles 2-digit year (>50 = 19xx)", () => {
        const csv = "Date,Amount\n01/15/99,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "MM/DD/YYYY" }));
        expect(result.transactions[0].date).toBe("1999-01-15");
      });

      it("handles 2-digit year (<=50 = 20xx)", () => {
        const csv = "Date,Amount\n01/15/26,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "MM/DD/YYYY" }));
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("returns sample dates (up to 3 unique)", () => {
        const csv =
          "Date,Amount\n01/15/2026,-50.00\n01/16/2026,-30.00\n01/17/2026,-20.00\n01/18/2026,-10.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.sampleDates).toHaveLength(3);
        expect(result.sampleDates).toEqual([
          "01/15/2026",
          "01/16/2026",
          "01/17/2026",
        ]);
      });

      it("deduplicates sample dates", () => {
        const csv =
          "Date,Amount\n01/15/2026,-50.00\n01/15/2026,-30.00\n01/16/2026,-20.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.sampleDates).toEqual(["01/15/2026", "01/16/2026"]);
      });
    });

    describe("transfer rules", () => {
      it("matches transfer by payee pattern", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-500.00,Transfer to Savings\n";
        const rules: CsvTransferRule[] = [
          {
            type: "payee",
            pattern: "Transfer to Savings",
            accountName: "Savings Account",
          },
        ];
        const result = parseCsv(csv, baseConfig(), rules);

        expect(result.transactions[0].isTransfer).toBe(true);
        expect(result.transactions[0].transferAccount).toBe("Savings Account");
        expect(result.transactions[0].category).toBe("");
      });

      it("matches transfer by category pattern", () => {
        const csv =
          "Date,Amount,Payee,Category\n01/15/2026,-500.00,Bank,[Savings]\n";
        const config = baseConfig({ category: 3 });
        const rules: CsvTransferRule[] = [
          {
            type: "category",
            pattern: "[Savings]",
            accountName: "Savings Account",
          },
        ];
        const result = parseCsv(csv, config, rules);

        expect(result.transactions[0].isTransfer).toBe(true);
        expect(result.transactions[0].transferAccount).toBe("Savings Account");
        expect(result.transactions[0].category).toBe("");
      });

      it("uses case-insensitive contains matching", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-500.00,TRANSFER TO SAVINGS ACCOUNT\n";
        const rules: CsvTransferRule[] = [
          {
            type: "payee",
            pattern: "transfer to savings",
            accountName: "Savings",
          },
        ];
        const result = parseCsv(csv, baseConfig(), rules);

        expect(result.transactions[0].isTransfer).toBe(true);
        expect(result.transactions[0].transferAccount).toBe("Savings");
      });

      it("matches partial payee value (contains)", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-200.00,Interac e-Transfer to John\n";
        const rules: CsvTransferRule[] = [
          { type: "payee", pattern: "e-Transfer", accountName: "John Account" },
        ];
        const result = parseCsv(csv, baseConfig(), rules);

        expect(result.transactions[0].isTransfer).toBe(true);
        expect(result.transactions[0].transferAccount).toBe("John Account");
      });

      it("collects transfer accounts sorted", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-500.00,Xfer Savings\n01/16/2026,-200.00,Xfer Checking\n01/17/2026,-100.00,Xfer Savings\n";
        const rules: CsvTransferRule[] = [
          { type: "payee", pattern: "Xfer Savings", accountName: "Savings" },
          { type: "payee", pattern: "Xfer Checking", accountName: "Checking" },
        ];
        const result = parseCsv(csv, baseConfig(), rules);

        expect(result.transferAccounts).toEqual(["Checking", "Savings"]);
      });

      it("does not create transfer when no rules match", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,-50.00,Grocery Store\n";
        const rules: CsvTransferRule[] = [
          { type: "payee", pattern: "Transfer", accountName: "Savings" },
        ];
        const result = parseCsv(csv, baseConfig(), rules);

        expect(result.transactions[0].isTransfer).toBe(false);
        expect(result.transactions[0].transferAccount).toBe("");
      });
    });

    describe("quoted fields", () => {
      it("handles quoted fields with commas inside", () => {
        const csv = 'Date,Amount,Payee\n01/15/2026,-50.00,"Smith, John"\n';
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].payee).toBe("Smith, John");
      });

      it("handles escaped double quotes inside quoted fields", () => {
        const csv =
          'Date,Amount,Payee\n01/15/2026,-50.00,"The ""Best"" Store"\n';
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toBe('The "Best" Store');
      });

      it("handles quoted fields with newlines inside", () => {
        const csv = 'Date,Amount,Memo\n01/15/2026,-50.00,"Line 1\nLine 2"\n';
        const config = baseConfig({ memo: 2, payee: undefined });
        const result = parseCsv(csv, config);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].memo).toBe("Line 1\nLine 2");
      });
    });

    describe("empty optional fields", () => {
      it("handles missing payee", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,-50.00,\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].payee).toBe("");
      });

      it("handles missing memo and category", () => {
        const csv =
          "Date,Amount,Payee,Memo,Category\n01/15/2026,-50.00,Store,,\n";
        const config = baseConfig({ memo: 3, category: 4 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].memo).toBe("");
        expect(result.transactions[0].category).toBe("");
      });

      it("handles columns beyond row length gracefully", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const config = baseConfig({ payee: 5, memo: 6 });
        const result = parseCsv(csv, config);

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].payee).toBe("");
        expect(result.transactions[0].memo).toBe("");
      });
    });

    describe("HTML sanitization", () => {
      it("strips HTML angle brackets from payee", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-50.00,<script>alert(1)</script>\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toBe("scriptalert(1)/script");
      });

      it("converts all-caps payee to Proper Case", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-50.00,WALMART GROCERY STORE\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toBe("Walmart Grocery Store");
      });

      it("leaves mixed-case payee unchanged", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-50.00,McDonald's Restaurant\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toBe("McDonald's Restaurant");
      });

      it("converts all-caps payee with numbers and symbols", () => {
        const csv =
          "Date,Amount,Payee\n01/15/2026,-50.00,COSTCO #1234 - WAREHOUSE\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toBe("Costco #1234 - Warehouse");
      });

      it("strips HTML angle brackets from memo", () => {
        const csv =
          "Date,Amount,Payee,Memo\n01/15/2026,-50.00,Store,<img src=x onerror=alert(1)>\n";
        const config = baseConfig({ memo: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].memo).toBe("img src=x onerror=alert(1)");
      });

      it("strips HTML angle brackets from category", () => {
        const csv =
          "Date,Amount,Payee,Category\n01/15/2026,-50.00,Store,<b>Food</b>\n";
        const config = baseConfig({ category: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toBe("bFood/b");
      });
    });

    describe("truncation of long values", () => {
      it("truncates payee to 255 characters", () => {
        const longPayee = "A".repeat(300);
        const csv = `Date,Amount,Payee\n01/15/2026,-50.00,${longPayee}\n`;
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].payee).toHaveLength(255);
      });

      it("truncates memo to 5000 characters", () => {
        const longMemo = "B".repeat(6000);
        const csv = `Date,Amount,Payee,Memo\n01/15/2026,-50.00,Store,${longMemo}\n`;
        const config = baseConfig({ memo: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].memo).toHaveLength(5000);
      });

      it("truncates reference number to 100 characters", () => {
        const longRef = "C".repeat(150);
        const csv = `Date,Amount,Payee,Ref\n01/15/2026,-50.00,Store,${longRef}\n`;
        const config = baseConfig({ referenceNumber: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].number).toHaveLength(100);
      });

      it("truncates category to 255 characters", () => {
        const longCategory = "D".repeat(300);
        const csv = `Date,Amount,Payee,Category\n01/15/2026,-50.00,Store,${longCategory}\n`;
        const config = baseConfig({ category: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toHaveLength(255);
      });
    });

    describe("dates with time components", () => {
      it("strips time after space (HH:MM:SS)", () => {
        const csv = "Date,Amount,Payee\n01/15/2026 14:30:00,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("strips time after space (H:MM AM/PM)", () => {
        const csv = "Date,Amount,Payee\n01/15/2026 2:30 PM,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("strips ISO 8601 time (T separator)", () => {
        const csv = "Date,Amount,Payee\n2026-01-15T12:00:00Z,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "YYYY-MM-DD" }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("strips time with timezone offset", () => {
        const csv =
          "Date,Amount,Payee\n2026-01-15T14:30:00+05:00,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "YYYY-MM-DD" }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("handles DD/MM/YYYY with time", () => {
        const csv = "Date,Amount,Payee\n15/01/2026 09:45,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "DD/MM/YYYY" }));

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });

      it("still parses dates without time normally", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,-50.00,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-15");
      });
    });

    describe("unparseable dates", () => {
      it("skips rows with unparseable dates", () => {
        const csv =
          "Date,Amount,Payee\nJanuary 15 2026,-50.00,Store\n01/16/2026,-30.00,Shop\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].date).toBe("2026-01-16");
      });

      it("skips rows with empty date field", () => {
        const csv =
          "Date,Amount,Payee\n,-50.00,Store\n01/16/2026,-30.00,Shop\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].payee).toBe("Shop");
      });

      it("skips rows with invalid date ranges", () => {
        const csv =
          "Date,Amount,Payee\n13/32/2026,-50.00,Store\n01/15/2026,-30.00,Shop\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(1);
        expect(result.transactions[0].payee).toBe("Shop");
      });
    });

    describe("amount formatting", () => {
      it("handles currency symbol ($)", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,$1234.56,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(1234.56);
      });

      it("handles currency symbol (pound)", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,\u00A31234.56,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(1234.56);
      });

      it("handles currency symbol (euro)", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,\u20AC1234.56,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(1234.56);
      });

      it("handles commas as thousands separators", () => {
        const csv = 'Date,Amount\n01/15/2026,"1,234.56"\n';
        const result = parseCsv(csv, baseConfig({ payee: undefined }));

        expect(result.transactions[0].amount).toBe(1234.56);
      });

      it("handles parentheses as negative notation", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,(50.00),Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(-50);
      });

      it("handles negative amount with currency symbol", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,-$50.00,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(-50);
      });

      it("treats empty amount as zero", () => {
        const csv = "Date,Amount,Payee\n01/15/2026,,Store\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].amount).toBe(0);
      });
    });

    describe("categories extraction", () => {
      it("collects unique categories sorted", () => {
        const csv =
          "Date,Amount,Payee,Category\n01/15/2026,-50.00,Store,Food\n01/16/2026,-30.00,Bus,Transport\n01/17/2026,-20.00,Market,Food\n";
        const config = baseConfig({ category: 3 });
        const result = parseCsv(csv, config);

        expect(result.categories).toEqual(["Food", "Transport"]);
      });

      it("does not include empty categories", () => {
        const csv =
          "Date,Amount,Payee,Category\n01/15/2026,-50.00,Store,Food\n01/16/2026,-30.00,Bus,\n";
        const config = baseConfig({ category: 3 });
        const result = parseCsv(csv, config);

        expect(result.categories).toEqual(["Food"]);
      });

      it("does not include category when transfer rule matches", () => {
        const csv =
          "Date,Amount,Payee,Category\n01/15/2026,-500.00,Xfer,Transfers\n01/16/2026,-30.00,Store,Food\n";
        const config = baseConfig({ category: 3 });
        const rules: CsvTransferRule[] = [
          {
            type: "category",
            pattern: "Transfers",
            accountName: "Savings",
          },
        ];
        const result = parseCsv(csv, config, rules);

        expect(result.categories).toEqual(["Food"]);
        expect(result.transferAccounts).toEqual(["Savings"]);
      });
    });

    describe("default result fields", () => {
      it("sets accountType to CHEQUING", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.accountType).toBe("CHEQUING");
      });

      it("sets accountName to empty string", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.accountName).toBe("");
      });

      it("sets securities to empty array", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.securities).toEqual([]);
      });

      it("uses the provided dateFormat as detectedDateFormat", () => {
        const csv = "Date,Amount\n15/01/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig({ dateFormat: "DD/MM/YYYY" }));
        expect(result.detectedDateFormat).toBe("DD/MM/YYYY");
      });

      it("sets openingBalance and openingBalanceDate to null", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());
        expect(result.openingBalance).toBeNull();
        expect(result.openingBalanceDate).toBeNull();
      });
    });

    describe("transaction default fields", () => {
      it("sets cleared and reconciled to false", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions[0].cleared).toBe(false);
        expect(result.transactions[0].reconciled).toBe(false);
      });

      it("sets investment fields to defaults", () => {
        const csv = "Date,Amount\n01/15/2026,-50.00\n";
        const result = parseCsv(csv, baseConfig());
        const tx = result.transactions[0];

        expect(tx.security).toBe("");
        expect(tx.action).toBe("");
        expect(tx.price).toBe(0);
        expect(tx.quantity).toBe(0);
        expect(tx.commission).toBe(0);
        expect(tx.splits).toEqual([]);
      });
    });

    describe("Windows-style line endings", () => {
      it("handles CRLF line endings", () => {
        const csv =
          "Date,Amount,Payee\r\n01/15/2026,-50.00,Store\r\n01/16/2026,-30.00,Shop\r\n";
        const result = parseCsv(csv, baseConfig());

        expect(result.transactions).toHaveLength(2);
        expect(result.transactions[0].payee).toBe("Store");
        expect(result.transactions[1].payee).toBe("Shop");
      });
    });

    describe("reference number mapping", () => {
      it("maps reference number column", () => {
        const csv = "Date,Amount,Payee,Ref\n01/15/2026,-50.00,Store,CHK1234\n";
        const config = baseConfig({ referenceNumber: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].number).toBe("CHK1234");
      });
    });

    describe("subcategory mapping", () => {
      it("combines category and subcategory with colon separator", () => {
        const csv =
          "Date,Amount,Payee,Category,Subcategory\n01/15/2026,-50.00,Store,Food,Groceries\n";
        const config = baseConfig({ category: 3, subcategory: 4 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toBe("Food:Groceries");
        expect(result.categories).toEqual(["Food:Groceries"]);
      });

      it("uses only category when subcategory is empty", () => {
        const csv =
          "Date,Amount,Payee,Category,Subcategory\n01/15/2026,-50.00,Store,Food,\n";
        const config = baseConfig({ category: 3, subcategory: 4 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toBe("Food");
      });

      it("uses only subcategory when category is empty", () => {
        const csv =
          "Date,Amount,Payee,Category,Subcategory\n01/15/2026,-50.00,Store,,Groceries\n";
        const config = baseConfig({ category: 3, subcategory: 4 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toBe("Groceries");
      });

      it("uses subcategory column without category column", () => {
        const csv =
          "Date,Amount,Payee,Subcategory\n01/15/2026,-50.00,Store,Groceries\n";
        const config = baseConfig({ subcategory: 3 });
        const result = parseCsv(csv, config);

        expect(result.transactions[0].category).toBe("Groceries");
      });

      it("collects combined categories in category list", () => {
        const csv =
          "Date,Amount,Payee,Category,Subcategory\n01/15/2026,-50.00,Store,Food,Groceries\n01/16/2026,-30.00,Bus,Transport,Bus Fare\n01/17/2026,-20.00,Market,Food,Groceries\n";
        const config = baseConfig({ category: 3, subcategory: 4 });
        const result = parseCsv(csv, config);

        expect(result.categories).toEqual([
          "Food:Groceries",
          "Transport:Bus Fare",
        ]);
      });
    });
  });
});
