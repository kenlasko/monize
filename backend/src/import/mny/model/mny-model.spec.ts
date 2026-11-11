import { AccountType } from "../../../accounts/entities/account.entity";
import { FREQUENCY_CYCLE_DAYS } from "../../../common/recurrence";
import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  MNY_FIXTURES,
  MnyFixtureName,
  readMnyFixture,
} from "../__fixtures__/mny-fixtures";
import { openMnyFile } from "../msisam/open-mny";
import { readMnyTables } from "../tables/read-mny-tables";
import {
  MNY_ACCOUNT_TYPE,
  MNY_CATEGORY_TYPE,
  MNY_CLEARED_STATUS,
  MNY_FREQUENCY,
  MNY_REAL_POSTING_FREQUENCY,
  MNY_TRANSACTION_FLAG,
  decodeReference,
  isCurrencyPseudoSecurity,
  isCurrencyQuoteSymbol,
  isDebtAccountRow,
  isIncomeCategoryType,
  isRecurrenceTemplate,
  isVoided,
  mapAccountType,
  mapFrequency,
  mapTransactionStatus,
} from "./mny-model";
import {
  MNY_ACTION,
  MNY_UNCONFIRMED_ACTIONS,
  hasInvestmentDetail,
  mapInvestmentAction,
} from "./mny-actions";

const ALL_FIXTURES = Object.keys(MNY_FIXTURES) as MnyFixtureName[];

function tablesOf(fixture: MnyFixtureName) {
  return readMnyTables(
    openMnyFile(readMnyFixture(fixture), MNY_FIXTURES[fixture].password),
  );
}

describe("mapAccountType", () => {
  it.each([
    [MNY_ACCOUNT_TYPE.BANK, AccountType.CHEQUING],
    [MNY_ACCOUNT_TYPE.CREDIT_CARD, AccountType.CREDIT_CARD],
    [MNY_ACCOUNT_TYPE.CASH, AccountType.CASH],
    [MNY_ACCOUNT_TYPE.ASSET, AccountType.ASSET],
    [MNY_ACCOUNT_TYPE.LOAN, AccountType.LOAN],
    [MNY_ACCOUNT_TYPE.INVESTMENT, AccountType.INVESTMENT],
    [MNY_ACCOUNT_TYPE.MORTGAGE, AccountType.MORTGAGE],
  ])("maps at %p to %s", (at, expected) => {
    expect(mapAccountType(at)).toBe(expected);
  });

  it.each([[-1], [7], [99]])("returns null for the unknown code %p", (at) => {
    expect(mapAccountType(at)).toBeNull();
  });
});

describe("transaction status", () => {
  it.each([
    [MNY_CLEARED_STATUS.UNRECONCILED, TransactionStatus.UNRECONCILED],
    [MNY_CLEARED_STATUS.CLEARED, TransactionStatus.CLEARED],
    [MNY_CLEARED_STATUS.RECONCILED, TransactionStatus.RECONCILED],
  ])("maps cs %p to %s", (cs, expected) => {
    expect(mapTransactionStatus(cs, 0)).toBe(expected);
  });

  it("falls back to unreconciled for an unknown cs", () => {
    // Safer direction: a wrongly-reconciled row hides a real discrepancy.
    expect(mapTransactionStatus(9, 0)).toBe(TransactionStatus.UNRECONCILED);
  });

  it("lets the void flag win over the reconciliation state", () => {
    expect(
      mapTransactionStatus(
        MNY_CLEARED_STATUS.RECONCILED,
        MNY_TRANSACTION_FLAG.VOID,
      ),
    ).toBe(TransactionStatus.VOID);
  });

  it("does not treat a loan payment as voided", () => {
    // 0x86 is the flag word every loan and mortgage payment in the
    // maintainer's file carries: 0x80 (debt account) | 0x4 | 0x2 (transfer
    // side). Reading 0x80 as void made all 1,084 of them import VOID, which
    // then excluded them from the balance, so every loan sat at its opening
    // balance forever.
    const loanPayment = 0x86;

    expect(isDebtAccountRow(loanPayment)).toBe(true);
    expect(isVoided(loanPayment)).toBe(false);
    expect(
      mapTransactionStatus(MNY_CLEARED_STATUS.RECONCILED, loanPayment),
    ).toBe(TransactionStatus.RECONCILED);
  });

  it("reads void and debt-account out of a combined word", () => {
    const flags =
      MNY_TRANSACTION_FLAG.VOID | MNY_TRANSACTION_FLAG.DEBT_ACCOUNT | 0x12;

    expect(isVoided(flags)).toBe(true);
    expect(isDebtAccountRow(flags)).toBe(true);
  });

  it("treats every observed non-void flag word as not voided", () => {
    // Every distinct grftt bit the maintainer's Money Plus file carries, minus
    // the void bit itself: transfer sides, investment rows, split parents and
    // children, debt-account rows and scheduled-series members. None is void.
    for (const flags of [
      0x2, 0x4, 0x6, 0x10, 0x12, 0x16, 0x20, 0x40, 0x42, 0x46, 0x80, 0x86, 0xa0,
      0xc0, 0x4086, 0x200016, 0x200086, 0x240016,
    ]) {
      expect(isVoided(flags)).toBe(false);
    }
  });
});

describe("isRecurrenceTemplate", () => {
  it("treats frq -1 as a real posting", () => {
    expect(isRecurrenceTemplate(MNY_REAL_POSTING_FREQUENCY)).toBe(false);
  });

  it.each([[0], [3], [12]])("treats frq %p as a template", (frequency) => {
    expect(isRecurrenceTemplate(frequency)).toBe(true);
  });
});

describe("decodeReference", () => {
  // Imported whole, `szId` put "1Debit" and "0           2" in the register.
  it.each([
    ["1Debit", "Debit"],
    ["1PC Banking", "PC Banking"],
    ["1ATM", "ATM"],
    ["1Telebank", "Telebank"],
    ["1EComm", "EComm"],
    ["1US", "US"],
  ])("reads the text %p as %p", (raw, expected) => {
    expect(decodeReference(raw)).toBe(expected);
  });

  it.each([
    ["0         155", "155"],
    ["0           1", "1"],
    ["0         200", "200"],
  ])("reads the cheque number %p as %p", (raw, expected) => {
    expect(decodeReference(raw)).toBe(expected);
  });

  it("keeps the payment number on a loan or mortgage row", () => {
    // Issue #1174: this shape is Money's "Pmt Num" column, which its loan
    // register does display, so dropping it left Ref. num. empty on every row
    // of every debt account. Nothing about the account changes the decoding --
    // the function no longer takes the flags that used to decide it.
    expect(decodeReference("0           2")).toBe("2");
    expect(decodeReference("0          14")).toBe("14");
    // The text kind is a real reference wherever it appears.
    expect(decodeReference("1Debit")).toBe("Debit");
  });

  it("keeps a value that does not fit either shape rather than losing it", () => {
    // The one that matters: a cheque number a user typed as 1042 is not the
    // text "042" behind a kind digit.
    expect(decodeReference("1042")).toBe("1042");
    expect(decodeReference("2something")).toBe("2something");
    expect(decodeReference("0 not-a-number")).toBe("0 not-a-number");
    expect(decodeReference("7")).toBe("7");
  });

  it("returns null for nothing at all", () => {
    expect(decodeReference(null)).toBeNull();
    expect(decodeReference("")).toBeNull();
    expect(decodeReference("   ")).toBeNull();
  });

  it("never leaves the packed shape in what it returns", () => {
    // No committed fixture carries a single `szId` -- all three are null
    // throughout -- so the shapes above come from the two Money Plus files that
    // cannot be committed. This is the general guard: whatever the padding
    // width, a kind digit followed by spaces never survives, and the number
    // behind it does.
    for (const width of [2, 5, 12, 20]) {
      const padded = `0${"7".padStart(width, " ")}`;

      expect(decodeReference(padded)).toBe("7");
    }
  });
});

describe("mapInvestmentAction", () => {
  it.each([
    [MNY_ACTION.BUY_LEGACY, InvestmentAction.BUY],
    [MNY_ACTION.BUY, InvestmentAction.BUY],
    [MNY_ACTION.SELL, InvestmentAction.SELL],
    [MNY_ACTION.DIVIDEND, InvestmentAction.DIVIDEND],
    [MNY_ACTION.INTEREST, InvestmentAction.INTEREST],
    [MNY_ACTION.REINVEST, InvestmentAction.REINVEST],
    [MNY_ACTION.REINVEST_INTEREST, InvestmentAction.REINVEST_INTEREST],
    [MNY_ACTION.CONTRIBUTION, InvestmentAction.REINVEST],
    [MNY_ACTION.REINVEST_ALT, InvestmentAction.REINVEST],
    [MNY_ACTION.CAPITAL_GAIN, InvestmentAction.CAPITAL_GAIN],
    [MNY_ACTION.ST_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_SHORT],
    [MNY_ACTION.LT_CAPITAL_GAINS_DIST, InvestmentAction.CAPITAL_GAIN_LONG],
    [
      MNY_ACTION.REINVEST_ST_CAPITAL_GAINS,
      InvestmentAction.REINVEST_CAPITAL_GAIN_SHORT,
    ],
    [
      MNY_ACTION.REINVEST_LT_CAPITAL_GAINS,
      InvestmentAction.REINVEST_CAPITAL_GAIN_LONG,
    ],
    [MNY_ACTION.REDEEM_CD_BOND, InvestmentAction.REDEEM],
    [MNY_ACTION.ADD_SHARES, InvestmentAction.ADD_SHARES],
    [MNY_ACTION.TRANSFER_IN, InvestmentAction.TRANSFER_IN],
    [MNY_ACTION.TRANSFER_OUT, InvestmentAction.TRANSFER_OUT],
  ])("maps act %p to %s", (act, expected) => {
    expect(mapInvestmentAction(act, "msisam")).toBe(expected);
  });

  it("maps act 4 to INTEREST, never DIVIDEND", () => {
    // Money's "Interest" activity lands on tax reports as interest income
    // (issue #1149); while the code's name was unknown it imported as
    // DIVIDEND, which misfiled every fixed-income interest payment.
    expect(mapInvestmentAction(MNY_ACTION.INTEREST, "msisam")).toBe(
      InvestmentAction.INTEREST,
    );
    expect(mapInvestmentAction(MNY_ACTION.INTEREST, "msisam")).not.toBe(
      InvestmentAction.DIVIDEND,
    );
  });

  it("preserves Money's income kind rather than collapsing onto a base action", () => {
    // Issue #1149's point: short- and long-term capital gains are taxed
    // differently, and reinvested interest is interest. Collapsing these onto
    // REINVEST/CAPITAL_GAIN/SELL at import time would lose the distinction
    // permanently -- the refinements behave like their base but keep the kind.
    expect(
      mapInvestmentAction(MNY_ACTION.ST_CAPITAL_GAINS_DIST, "msisam"),
    ).not.toBe(InvestmentAction.CAPITAL_GAIN);
    expect(
      mapInvestmentAction(MNY_ACTION.LT_CAPITAL_GAINS_DIST, "msisam"),
    ).not.toBe(InvestmentAction.CAPITAL_GAIN);
    expect(
      mapInvestmentAction(MNY_ACTION.REINVEST_INTEREST, "msisam"),
    ).not.toBe(InvestmentAction.REINVEST);
  });

  it("maps act 30 to REDEEM, never REMOVE_SHARES", () => {
    // "Redeem CD/Bond" is a disposal with real proceeds -- the cash figure,
    // accrued interest included, has to reach the cash sleeve. REMOVE_SHARES
    // would zero the total and lose the proceeds (issue #1149).
    expect(mapInvestmentAction(MNY_ACTION.REDEEM_CD_BOND, "msisam")).toBe(
      InvestmentAction.REDEEM,
    );
  });

  it("maps act 16 to REMOVE_SHARES, never SELL", () => {
    // Mapping it to SELL closes lots against a fabricated sale price and
    // corrupts average cost -- PR #192 issue 4.
    expect(mapInvestmentAction(MNY_ACTION.REMOVE_SHARES_LEGACY, "msisam")).toBe(
      InvestmentAction.REMOVE_SHARES,
    );
    expect(
      mapInvestmentAction(MNY_ACTION.REMOVE_SHARES_LEGACY, "msisam"),
    ).not.toBe(InvestmentAction.SELL);
  });

  it.each([[6], [17], [18], [20], [99]])(
    "returns null for the unknown act %p",
    (act) => {
      // 17, 18 and 20 occur in real Money Plus files but open and close no
      // lot, and nothing names them, so nothing says what they do to a
      // position. They are skipped and warned about rather than guessed at.
      // (10 sat in this list until issue #1149 named it "Reinvest Interest".)
      expect(mapInvestmentAction(act, "msisam")).toBeNull();
    },
  );

  it("maps act 1 to BUY, never SELL", () => {
    // The defect this guards: PR #192's format reference had act 1 as SELL.
    // LOT disagrees -- act 1 opens 3,520 lots in the maintainer's file and
    // closes none -- so every purchase imported as a sale, no cash ever left
    // a brokerage sleeve, and holdings replayed negative.
    expect(mapInvestmentAction(MNY_ACTION.BUY, "msisam")).toBe(
      InvestmentAction.BUY,
    );
    expect(mapInvestmentAction(MNY_ACTION.BUY, "msisam")).not.toBe(
      InvestmentAction.SELL,
    );
  });

  it("maps the codes LOT proves acquire shares onto acquisitions", () => {
    // Whatever act a LOT.htrnBuy row carries opens a position, by definition.
    for (const act of [
      MNY_ACTION.BUY,
      MNY_ACTION.REINVEST,
      MNY_ACTION.CONTRIBUTION,
      MNY_ACTION.TRANSFER_IN,
    ]) {
      expect(mapInvestmentAction(act, "msisam")).not.toBeNull();
      expect([
        InvestmentAction.BUY,
        InvestmentAction.REINVEST,
        InvestmentAction.TRANSFER_IN,
        InvestmentAction.ADD_SHARES,
      ]).toContain(mapInvestmentAction(act, "msisam"));
    }
  });

  it("maps the codes LOT proves dispose of shares onto disposals", () => {
    for (const act of [
      MNY_ACTION.SELL,
      MNY_ACTION.REMOVE_SHARES,
      MNY_ACTION.TRANSFER_OUT,
    ]) {
      expect([
        InvestmentAction.SELL,
        InvestmentAction.REMOVE_SHARES,
        InvestmentAction.TRANSFER_OUT,
      ]).toContain(mapInvestmentAction(act, "msisam"));
    }
  });

  it("flags the inferred action codes so mappers can warn", () => {
    // act 4 is deliberately absent: its cash-only behaviour was measured on
    // both Money Plus files and issue #1149 supplied Money's name for it, so
    // nothing about it is assumed any more. The issue-#1149 family (10, 24,
    // 26, 27, 29, 30) stays flagged until a file measures its TRN_INV shape.
    expect([...MNY_UNCONFIRMED_ACTIONS].sort((a, b) => a - b)).toEqual([
      MNY_ACTION.REINVEST_ALT,
      MNY_ACTION.REINVEST_INTEREST,
      MNY_ACTION.CONTRIBUTION,
      MNY_ACTION.CAPITAL_GAIN,
      MNY_ACTION.ST_CAPITAL_GAINS_DIST,
      MNY_ACTION.LT_CAPITAL_GAINS_DIST,
      MNY_ACTION.REINVEST_ST_CAPITAL_GAINS,
      MNY_ACTION.REINVEST_LT_CAPITAL_GAINS,
      MNY_ACTION.REDEEM_CD_BOND,
    ]);
  });

  it("knows that cash distributions carry no TRN_INV row", () => {
    // Iterating TRN_INV instead of TRN drops every cash dividend.
    expect(hasInvestmentDetail(MNY_ACTION.DIVIDEND, "msisam")).toBe(false);
    expect(hasInvestmentDetail(MNY_ACTION.INTEREST, "msisam")).toBe(false);
    expect(
      hasInvestmentDetail(MNY_ACTION.ST_CAPITAL_GAINS_DIST, "msisam"),
    ).toBe(false);
    expect(
      hasInvestmentDetail(MNY_ACTION.LT_CAPITAL_GAINS_DIST, "msisam"),
    ).toBe(false);
    expect(hasInvestmentDetail(MNY_ACTION.BUY, "msisam")).toBe(true);
    expect(hasInvestmentDetail(MNY_ACTION.SELL, "msisam")).toBe(true);
    // The reinvested distributions buy shares, so their detail is expected.
    expect(hasInvestmentDetail(MNY_ACTION.REINVEST_INTEREST, "msisam")).toBe(
      true,
    );
    expect(hasInvestmentDetail(MNY_ACTION.REDEEM_CD_BOND, "msisam")).toBe(true);
  });
});

describe("currency pseudo-securities", () => {
  it.each([["/GBPUS"], ["/ARSUS"], ["/AUDUS"]])(
    "recognises the currency quote symbol %s",
    (symbol) => {
      expect(isCurrencyQuoteSymbol(symbol)).toBe(true);
    },
  );

  it.each([["VOO"], ["$US:INDU"], ["/GBP"], [""], ["/gbpus"]])(
    "does not mistake %p for a currency",
    (symbol) => {
      expect(isCurrencyQuoteSymbol(symbol)).toBe(false);
    },
  );

  it("excludes a row by the symbol shape alone", () => {
    // No `sct` code is read here: 4 was, on the theory that it meant currency,
    // and it is Money's money-market fund. Nothing else distinguishes a
    // currency row, and sct codes shift between releases besides.
    expect(isCurrencyPseudoSecurity("/GBPUS")).toBe(true);
    expect(isCurrencyPseudoSecurity("$XAL.X")).toBe(false);
    expect(isCurrencyPseudoSecurity("TDB164")).toBe(false);
  });

  it("matches every currency quote symbol in every fixture", () => {
    for (const fixture of ALL_FIXTURES) {
      const { currencies } = tablesOf(fixture).reference;
      const quoted = currencies.filter(
        (currency) => currency.quoteSymbol !== "",
      );

      // Money 2001+ quote over 40 currencies; Money 99 quotes 24, each in the
      // same `/XXXUS` shape.
      expect(quoted.length).toBeGreaterThan(20);
      expect(
        quoted.every((currency) => isCurrencyQuoteSymbol(currency.quoteSymbol)),
      ).toBe(true);
    }
  });

  it("keeps every real security in the fixtures", () => {
    // No fixture contains a currency pseudo-security, so the exclusion must
    // not fire at all here.
    for (const fixture of ALL_FIXTURES) {
      const { securities } = tablesOf(fixture).investments;

      expect(
        securities.some((security) =>
          isCurrencyPseudoSecurity(security.symbol),
        ),
      ).toBe(false);
    }
  });
});

describe("isIncomeCategoryType", () => {
  it.each([
    [MNY_CATEGORY_TYPE.INCOME, true],
    [MNY_CATEGORY_TYPE.INCOME_ALT, true],
    [MNY_CATEGORY_TYPE.EXPENSE, false],
    [MNY_CATEGORY_TYPE.EXPENSE_ALT, false],
  ])("classifies lType %p as income=%p", (categoryType, expected) => {
    expect(isIncomeCategoryType(categoryType)).toBe(expected);
  });

  it.each([[MNY_CATEGORY_TYPE.ROOT], [7]])(
    "returns null for lType %p so the caller walks to the root",
    (categoryType) => {
      expect(isIncomeCategoryType(categoryType)).toBeNull();
    },
  );

  it("agrees with the root ancestor for every category in every fixture", () => {
    // The evidence behind the constant: categories across four Money vintages,
    // no crossover between the lType groups and the two roots. Money names
    // the roots in the file's language: `sample-money99.mny` is Spanish.
    const INCOME_ROOT_NAMES = new Set(["INCOME", "INGRESOS"]);
    let checked = 0;

    for (const fixture of ALL_FIXTURES) {
      const { categories } = tablesOf(fixture).reference;
      const byHandle = new Map(
        categories.map((category) => [category.handle, category]),
      );

      for (const category of categories) {
        let root = category;
        while (root.parent !== null && byHandle.has(root.parent)) {
          root = byHandle.get(root.parent)!;
        }

        const fromType = isIncomeCategoryType(category.categoryType);
        if (fromType !== null) {
          expect(fromType).toBe(INCOME_ROOT_NAMES.has(root.name));
          checked++;
        } else {
          // Only the roots themselves are unclassifiable.
          expect(category.categoryType).toBe(MNY_CATEGORY_TYPE.ROOT);
        }
      }
    }

    expect(checked).toBeGreaterThan(300);
  });
});

/**
 * Every cadence Microsoft Money's bill frequency picker offers, with the
 * `(BILL.frq, BILL.cFrqInst)` pair it stores and the Monize frequency it is.
 *
 * This is evidence, not a reference table. Each row was read out of a Money
 * Plus Sunset file in which one bill per cadence was created with the picker's
 * own wording written into the payee memo, then cross-checked against the
 * spacing of the instance dates of that file's own long-running series -- a
 * `frq` 4 series is 3 months apart, `frq` 2 at 0.5 is 14 days apart, `frq` 3
 * at 2 is a semi-monthly payroll on the 15th and the last day.
 *
 * What it shows is that `cFrqInst` is a **rate** -- occurrences per unit --
 * and not an interval multiplier. Read the other way round, `frq` 3 at 2 (a
 * payroll paid twice a month) imports as every two months, and `frq` 3 at 0.5
 * (the real every-other-month) rounds to 1 and imports as monthly. Both were
 * live defects; the fractional values are the tell.
 */
const MONEY_CADENCES: readonly [string, number, number, FrequencyType][] = [
  ["Only once", MNY_FREQUENCY.ONCE, 1, FrequencyType.ONCE],
  ["Daily", MNY_FREQUENCY.DAILY, 1, FrequencyType.DAILY],
  ["Weekly", MNY_FREQUENCY.WEEKLY, 1, FrequencyType.WEEKLY],
  ["Every two weeks", MNY_FREQUENCY.WEEKLY, 0.5, FrequencyType.BIWEEKLY],
  ["Every four weeks", MNY_FREQUENCY.WEEKLY, 0.25, FrequencyType.EVERY4WEEKS],
  ["Twice a month", MNY_FREQUENCY.MONTHLY, 2, FrequencyType.SEMIMONTHLY],
  ["Monthly", MNY_FREQUENCY.MONTHLY, 1, FrequencyType.MONTHLY],
  ["Every other month", MNY_FREQUENCY.MONTHLY, 0.5, FrequencyType.EVERY2MONTHS],
  ["Every three months", MNY_FREQUENCY.QUARTERLY, 1, FrequencyType.QUARTERLY],
  [
    "Every four months",
    MNY_FREQUENCY.MONTHLY,
    0.25,
    FrequencyType.EVERY4MONTHS,
  ],
  ["Twice a year", MNY_FREQUENCY.YEARLY, 2, FrequencyType.SEMIANNUAL],
  ["Yearly", MNY_FREQUENCY.YEARLY, 1, FrequencyType.YEARLY],
  ["Every other year", MNY_FREQUENCY.YEARLY, 0.5, FrequencyType.EVERY2YEARS],
];

describe("mapFrequency", () => {
  it.each(MONEY_CADENCES)(
    "maps Money's %s (frq=%p cFrqInst=%p) to %s exactly",
    (_label, frequency, rate, expected) => {
      expect(mapFrequency(frequency, rate)).toEqual({
        frequency: expected,
        approximate: false,
      });
    },
  );

  it("covers every Monize frequency exactly once", () => {
    // The two lists are the same length on purpose: EVERY4MONTHS and
    // EVERY2YEARS were added for the last two picker entries that had no type.
    // A frequency added here without a Money cadence, or a cadence that starts
    // sharing a type with another, shows up as a duplicate or a gap.
    // CUSTOM is the one Monize frequency Money has no cadence for: a rule of
    // chosen days has no fixed cycle (`FREQUENCY_CYCLE_DAYS.CUSTOM` is 0), so
    // no `(frq, cFrqInst)` pair can name it.
    expect(MONEY_CADENCES.map((row) => row[3]).sort()).toEqual(
      Object.keys(FREQUENCY_CYCLE_DAYS)
        .filter((frequency) => frequency !== FrequencyType.CUSTOM)
        .sort(),
    );
  });

  it("never maps a Money cadence to CUSTOM, which has no cycle", () => {
    expect(FREQUENCY_CYCLE_DAYS.CUSTOM).toBe(0);
    for (const unit of Object.values(MNY_FREQUENCY)) {
      for (const rate of [0.25, 0.5, 1, 2, 3, 4, 52, 365]) {
        expect(mapFrequency(unit, rate)?.frequency).not.toBe(
          FrequencyType.CUSTOM,
        );
      }
    }
  });

  it("reads cFrqInst as a rate, not as an interval (twice a month)", () => {
    // The defect this replaces: a semi-monthly payroll -- `frq` 3 with two
    // occurrences per month -- imported as EVERY2MONTHS, a quarter as often.
    expect(mapFrequency(MNY_FREQUENCY.MONTHLY, 2)?.frequency).toBe(
      FrequencyType.SEMIMONTHLY,
    );
  });

  it.each([
    [MNY_FREQUENCY.WEEKLY, 0.5, FrequencyType.BIWEEKLY],
    [MNY_FREQUENCY.WEEKLY, 0.25, FrequencyType.EVERY4WEEKS],
    [MNY_FREQUENCY.MONTHLY, 0.5, FrequencyType.EVERY2MONTHS],
    [MNY_FREQUENCY.MONTHLY, 0.25, FrequencyType.EVERY4MONTHS],
    [MNY_FREQUENCY.YEARLY, 0.5, FrequencyType.EVERY2YEARS],
  ])(
    "keeps the fractional rate frq=%p cFrqInst=%p as %s",
    (frequency, rate, expected) => {
      // Rounding a fractional rate to 1 -- which is what an interval reading
      // does with it -- collapsed all five of these onto their unit, so every
      // one of them fell due several times more often than the user asked.
      expect(mapFrequency(frequency, rate)?.frequency).toBe(expected);
    },
  );

  it("maps the quarterly unit rather than reporting frq=4 as unknown", () => {
    // PR #192's table claimed 4 = yearly; issue #1150 refuted that, and the
    // code was then left unmapped, so every "every three months" bill in a
    // single-instance series was dropped with an `unusableBill` warning.
    expect(mapFrequency(MNY_FREQUENCY.QUARTERLY, 1)).toEqual({
      frequency: FrequencyType.QUARTERLY,
      approximate: false,
    });
  });

  it("maps a yearly bill to YEARLY, not to every two months (issue #1150)", () => {
    // The regression: `frq` 5 was mapped to EVERY2MONTHS on PR #192's word,
    // and a Money Plus Sunset file's yearly bills imported six times a year.
    expect(mapFrequency(5)).toEqual({
      frequency: FrequencyType.YEARLY,
      approximate: false,
    });
  });

  it.each([
    // Every three weeks: 21 days. The longest cycle that does not exceed it is
    // SEMIMONTHLY's 15.22, not BIWEEKLY's 14 -- the rule is purely "longest
    // that still fires at least as often", and no cadence here is exempt from
    // it on the grounds of stepping by calendar day rather than by days.
    [MNY_FREQUENCY.WEEKLY, 1 / 3, FrequencyType.SEMIMONTHLY],
    // Every five months: between EVERY4MONTHS and SEMIANNUAL.
    [MNY_FREQUENCY.MONTHLY, 1 / 5, FrequencyType.EVERY4MONTHS],
    // Every three years: beyond the longest type.
    [MNY_FREQUENCY.YEARLY, 1 / 3, FrequencyType.EVERY2YEARS],
    // Twice a day: shorter than the shortest type.
    [MNY_FREQUENCY.DAILY, 2, FrequencyType.DAILY],
  ])(
    "approximates the unrepresentable frq=%p cFrqInst=%p down to %s",
    (frequency, rate, expected) => {
      // Down, never up: v1 imports bills with `auto_post = false`, so an extra
      // reminder is noise where a missed one is a missed payment.
      expect(mapFrequency(frequency, rate)).toEqual({
        frequency: expected,
        approximate: true,
      });
    },
  );

  it("ignores the rate on a one-off", () => {
    expect(mapFrequency(MNY_FREQUENCY.ONCE, 4)).toEqual({
      frequency: FrequencyType.ONCE,
      approximate: false,
    });
  });

  it.each([[0], [-4], [Number.NaN]])(
    "treats the nonsensical rate %p as one",
    (rate) => {
      expect(mapFrequency(MNY_FREQUENCY.WEEKLY, rate)).toEqual({
        frequency: FrequencyType.WEEKLY,
        approximate: false,
      });
    },
  );

  // Money's picker is exhausted by the five units above, so a code outside
  // them is a version or a dialog this repository has not seen. It is reported
  // (`unusableBill`, with the raw pair) rather than guessed -- and the bill
  // mapper reads the cadence off the series' own instance dates first.
  it.each([[6], [7], [8], [-1], [99]])(
    "returns null for the unknown frq %p",
    (frequency) => {
      expect(mapFrequency(frequency)).toBeNull();
    },
  );
});
