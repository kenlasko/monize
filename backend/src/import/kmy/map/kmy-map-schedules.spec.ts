import { FrequencyType } from "../../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { SplitKind } from "../../../transactions/entities/split-kind.enum";
import {
  ScheduleInit,
  rawAccount,
  rawFile,
  rawPayee,
  rawSchedule,
  rawTag,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { mapKmySchedules } from "./kmy-map-schedules";

// Ordinals: roots 1-5, CHK 6, SAV 7, LOAN 8, GRO 9, FEE 10, STK 11 (+INV 12).
const ACCOUNTS = [
  rawAccount({ id: "CHK", name: "Checking", type: 1 }),
  rawAccount({ id: "SAV", name: "Savings", type: 2 }),
  rawAccount({
    id: "LOAN",
    name: "Loan",
    type: 5,
    kvp: { "periodic-payment": "250/1" },
  }),
  rawAccount({ id: "GRO", name: "Groceries", type: 13 }),
  rawAccount({ id: "FEE", name: "Fees", type: 13 }),
  rawAccount({ id: "INV", name: "Broker", type: 7 }),
  rawAccount({
    id: "STK",
    name: "Stock",
    type: 15,
    parentId: "INV",
    currency: "E1",
  }),
  rawAccount({ id: "EUR", name: "Euro", type: 2, currency: "EUR" }),
  rawAccount({ id: "EGRO", name: "Euro Groceries", type: 13, currency: "EUR" }),
];

const bill = (
  account = "CHK",
  value = "-75",
): { account: string; value: string; payee?: string }[] => [
  { account, value },
  {
    account: "GRO",
    value: value.startsWith("-") ? value.slice(1) : `-${value}`,
  },
];

function run(
  schedules: ScheduleInit[],
  init: Parameters<typeof harness>[1] = { asOf: "2024-01-01" },
  asOf = "2024-01-01",
) {
  const raw = rawFile({
    accounts: ACCOUNTS,
    payees: [rawPayee("P1", "City Power")],
    tags: [rawTag("G1", "home")],
    schedules: schedules.map((s, i) =>
      rawSchedule({ id: `SCH${i + 1}`, ...s }),
    ),
  });
  return mapKmySchedules(harness(raw, init).context, asOf);
}

describe("mapKmySchedules: the worked example (spec 5.10.3)", () => {
  it("offers the electricity bill with its next due date, amount and category", () => {
    const result = run(
      [
        {
          name: "Electricity",
          type: 1,
          occurrence: 32,
          startDate: "2024-02-01",
          lastPayment: "2024-02-01",
          fixed: false,
          weekendOption: 1,
          template: {
            postDate: "2024-03-01",
            splits: [
              { account: "CHK", value: "-75", payee: "P1", tags: ["G1"] },
              { account: "GRO", value: "75", payee: "P1" },
            ],
          },
        },
      ],
      { asOf: "2024-05-01" },
      "2024-05-01",
    );
    expect(result.bills).toEqual([
      {
        handle: 1,
        seriesKey: 1,
        status: 1,
        name: "Electricity",
        accountKey: "acct-6",
        payeeHandle: 1,
        categoryHandle: 9,
        amount: -75,
        currencyCode: "USD",
        frequency: FrequencyType.MONTHLY,
        customRecurrence: null,
        approximate: false,
        nextDueDate: "2024-03-01",
        endDate: null,
        description: null,
        isTransfer: false,
        transferAccountKey: null,
        investment: null,
        splits: [],
        tagHandles: [1],
      },
    ]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "scheduleWeekendRuleDropped",
      "scheduleOverdue",
    ]);
    expect(result).toMatchObject({
      seriesInFile: 1,
      skipped: 0,
      supported: true,
    });
  });

  it("is overdue only when the next occurrence is already past asOf", () => {
    const schedule: ScheduleInit = {
      lastPayment: "2024-02-01",
      template: { postDate: "2024-03-01", splits: bill() },
    };
    expect(run([schedule], undefined, "2024-04-01").warnings).toEqual([]);
    expect(
      run([schedule], undefined, "2024-04-02").warnings.map((w) => w.code),
    ).toEqual(["scheduleOverdue"]);
    const once: ScheduleInit = {
      occurrence: 1,
      template: { postDate: "2024-03-01", splits: bill() },
    };
    expect(
      run([once], undefined, "2024-03-02").warnings.map((w) => w.code),
    ).toEqual(["scheduleOverdue"]);
    expect(run([once], undefined, "2024-03-01").warnings).toEqual([]);
  });
});

describe("mapKmySchedules: which schedules are offered (spec 5.10.1)", () => {
  it("does not offer a finished schedule", () => {
    const template = { postDate: "2024-03-01", splits: bill() };
    const result = run([
      { occurrence: 1, lastPayment: "2024-02-01", template },
      { endDate: "2024-02-15", lastPayment: "2024-02-15", template },
      { endDate: "2024-02-15", lastPayment: "2024-02-01", template },
      {
        endDate: "2024-02-15",
        lastPayment: "2024-01-01",
        template: { ...template, postDate: "2024-02-01" },
      },
    ]);
    expect(result.bills.map((b) => b.handle)).toEqual([4]);
    expect(result.skipped).toBe(0);
    expect(result.seriesInFile).toBe(4);
  });

  it.each([
    ["no template", { template: null }],
    ["an unknown occurrence", { occurrence: 0, template: { splits: bill() } }],
    [
      "no asset or liability split",
      {
        template: {
          splits: [
            { account: "GRO", value: "1" },
            { account: "FEE", value: "-1" },
          ],
        },
      },
    ],
    [
      "no usable date",
      { startDate: null, template: { postDate: null, splits: bill() } },
    ],
    ["an account that is not imported", { template: { splits: bill("SAV") } }],
  ] as [string, ScheduleInit][])(
    "flags a schedule with %s as unusable",
    (_name, schedule) => {
      const result = run([schedule], {
        options: {
          accounts: [{ handle: 7, include: false, currencyOverride: null }],
        },
      });
      expect(result.bills).toEqual([]);
      expect(result.skipped).toBe(1);
      expect(result.warnings.map((w) => w.code)).toEqual(["unusableBill"]);
    },
  );

  it("does not import a template with a split on a stock account", () => {
    const result = run([
      {
        template: {
          splits: [
            { account: "STK", value: "5", shares: "1" },
            { account: "CHK", value: "-5" },
          ],
        },
      },
    ]);
    expect(result.bills).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "investmentScheduleNotImported",
    ]);
  });
});

describe("mapKmySchedules: next due date (spec 5.10.3, reference 11.4)", () => {
  const due = (schedule: ScheduleInit) => run([schedule]).bills[0]?.nextDueDate;

  it("takes the template's date, the month's last day under lastDayInMonth", () => {
    expect(due({ template: { postDate: "2024-03-10", splits: bill() } })).toBe(
      "2024-03-10",
    );
    expect(
      due({
        lastDayInMonth: true,
        template: { postDate: "2024-02-10", splits: bill() },
      }),
    ).toBe("2024-02-29");
  });

  it("starts at the start date when the template has no date and nothing was paid", () => {
    expect(
      due({
        startDate: "2024-05-05",
        template: { postDate: null, splits: bill() },
      }),
    ).toBe("2024-05-05");
  });

  it("steps from the start date past the last payment when the date is empty or stale", () => {
    const stale = {
      startDate: "2024-01-31",
      lastPayment: "2024-02-29",
      template: { postDate: "2024-02-15", splits: bill() },
    };
    expect(due(stale)).toBe("2024-03-31");
    expect(
      due({ ...stale, template: { postDate: null, splits: bill() } }),
    ).toBe("2024-03-31");
    expect(
      due({
        ...stale,
        lastPayment: "2024-01-15",
        template: { postDate: null, splits: bill() },
      }),
    ).toBe("2024-01-31");
  });

  it("keeps an end date and drops an invalid one", () => {
    const template = { postDate: "2024-03-10", splits: bill() };
    expect(run([{ endDate: "2025-01-01", template }]).bills[0].endDate).toBe(
      "2025-01-01",
    );
    expect(run([{ endDate: "garbage", template }]).bills[0].endDate).toBeNull();
  });
});

describe("mapKmySchedules: cadence and flags", () => {
  const template = { postDate: "2024-03-04", splits: bill() };

  it("writes a custom recurrence and flags an approximated one", () => {
    const custom = run([{ occurrence: 4, multiplier: 3, template }]).bills[0];
    expect(custom).toMatchObject({
      frequency: FrequencyType.CUSTOM,
      approximate: false,
    });
    expect(custom.customRecurrence).toMatchObject({
      unit: "WEEK",
      interval: 3,
    });
    const approximate = run([{ occurrence: 2, multiplier: 30, template }]);
    expect(approximate.bills[0]).toMatchObject({
      frequency: FrequencyType.EVERY4WEEKS,
      approximate: true,
    });
    expect(approximate.warnings.map((w) => w.code)).toEqual([
      "billFrequencyApproximated",
    ]);
  });

  it("raises one warning each for auto-enter and the weekend rule, and none for MoveNothing (m0)", () => {
    // WeekendOption: MoveBefore 0 (what an absent attribute reads as), MoveAfter 1, MoveNothing 2.
    for (const weekendOption of [0, 1]) {
      expect(
        run([{ autoEnter: true, weekendOption, template }]).warnings.map(
          (w) => w.code,
        ),
      ).toEqual(["scheduleWeekendRuleDropped", "scheduleAutoEnterNotImported"]);
    }
    expect(run([{ weekendOption: 2, template }]).warnings).toEqual([]);
    expect(run([{ template }]).warnings).toEqual([]);
  });

  it("names a bill after the schedule, else its payee, else its ordinal", () => {
    const withPayee = {
      postDate: "2024-03-04",
      splits: [{ account: "CHK", value: "-1", payee: "P1" }],
    };
    expect(run([{ name: " Rent ", template }]).bills[0].name).toBe("Rent");
    expect(run([{ name: "", template: withPayee }]).bills[0].name).toBe(
      "City Power",
    );
    expect(run([{ name: "", template }]).bills[0].name).toBe("Schedule 1");
  });

  it("describes a bill by the account split's memo, else the template's", () => {
    expect(
      run([
        {
          template: {
            postDate: "2024-03-04",
            memo: "tx",
            splits: [{ account: "CHK", value: "-1", memo: "rent" }],
          },
        },
      ]).bills[0].description,
    ).toBe("rent");
    expect(
      run([
        {
          template: {
            postDate: "2024-03-04",
            memo: "tx",
            splits: [{ account: "CHK", value: "-1" }],
          },
        },
      ]).bills[0].description,
    ).toBe("tx");
  });
});

describe("mapKmySchedules: shape of the template (spec 5.10.3)", () => {
  it("imports a one-split template without a category", () => {
    const [b] = run([
      { template: { splits: [{ account: "CHK", value: "-5" }] } },
    ]).bills;
    expect(b).toMatchObject({
      amount: -5,
      categoryHandle: null,
      isTransfer: false,
      splits: [],
    });
  });

  it("imports a transfer between two asset accounts, or a type 4 one to an excluded account as plain", () => {
    const [b] = run([
      {
        type: 4,
        template: {
          splits: [
            { account: "CHK", value: "-100" },
            { account: "SAV", value: "100" },
          ],
        },
      },
    ]).bills;
    expect(b).toMatchObject({
      isTransfer: true,
      transferAccountKey: "acct-7",
      categoryHandle: null,
      amount: -100,
    });
    const [excluded] = run(
      [
        {
          template: {
            splits: [
              { account: "CHK", value: "-100" },
              { account: "SAV", value: "100" },
            ],
          },
        },
      ],
      {
        options: {
          accounts: [{ handle: 7, include: false, currencyOverride: null }],
        },
      },
    ).bills;
    expect(excluded).toMatchObject({
      isTransfer: false,
      transferAccountKey: null,
    });
  });

  it("builds legs for a template of three or more splits, as in 5.6.3", () => {
    const [b] = run([
      {
        template: {
          splits: [
            { account: "CHK", value: "-300" },
            { account: "GRO", value: "100", memo: "food" },
            { account: "SAV", value: "100" },
            { account: "FEE", value: "100" },
          ],
        },
      },
    ]).bills;
    expect(b).toMatchObject({
      amount: -300,
      categoryHandle: null,
      isTransfer: false,
    });
    expect(b.splits).toEqual([
      {
        kind: SplitKind.CATEGORY,
        categoryHandle: 9,
        transferAccountKey: null,
        amount: -100,
        memo: "food",
      },
      {
        kind: SplitKind.TRANSFER,
        categoryHandle: null,
        transferAccountKey: "acct-7",
        amount: -100,
        memo: null,
      },
      {
        kind: SplitKind.CATEGORY,
        categoryHandle: 10,
        transferAccountKey: null,
        amount: -100,
        memo: null,
      },
    ]);
  });

  it("puts the rounding residual on the largest leg and the imbalance on an uncategorized leg", () => {
    const rounding = run([
      {
        template: {
          commodity: "USD",
          splits: [
            { account: "EUR", value: "-1", shares: "-2/3" },
            { account: "EGRO", value: "1/3", shares: "1/3" },
            { account: "EGRO", value: "1/3", shares: "1/3" },
            { account: "EGRO", value: "1/3", shares: "1/3" },
          ],
        },
      },
    ]).bills[0];
    expect(rounding.amount).toBe(-0.6667);
    expect(rounding.splits.map((s) => s.amount)).toEqual([
      -0.2223, -0.2222, -0.2222,
    ]);
    const unbalanced = run([
      {
        template: {
          splits: [
            { account: "CHK", value: "-50" },
            { account: "GRO", value: "30" },
            { account: "FEE", value: "10" },
          ],
        },
      },
    ]).bills[0];
    expect(unbalanced.splits.map((s) => [s.categoryHandle, s.amount])).toEqual([
      [9, -30],
      [10, -10],
      [null, -10],
    ]);
  });

  it("converts a foreign-currency leg through the parent's ratio and survives a parent of value 0", () => {
    const [b] = run([
      {
        template: {
          commodity: "USD",
          splits: [
            { account: "EUR", value: "-1100", shares: "-1000" },
            { account: "GRO", value: "1000" },
            { account: "FEE", value: "100" },
          ],
        },
      },
    ]).bills;
    expect(b.currencyCode).toBe("EUR");
    expect(b.splits.map((s) => s.amount)).toEqual([-909.0909, -90.9091]);
    const [zero] = run([
      {
        template: {
          commodity: "USD",
          splits: [
            { account: "EUR", value: "0", shares: "-5" },
            { account: "GRO", value: "0", shares: "5" },
            { account: "FEE", value: "0", shares: "0" },
          ],
        },
      },
    ]).bills;
    expect(zero.splits.map((s) => s.amount)).toEqual([0, 0, -5]);
  });
});

describe("mapKmySchedules: loan payments (spec 5.10.3)", () => {
  const loanSplits = (payment: string) => [
    { account: "CHK", value: payment },
    { account: "LOAN", value: "autoCalc" },
    { account: "FEE", value: "autoCalc" },
  ];

  it("simplifies a payment with a fixed amount to one transfer to the loan", () => {
    const result = run([{ type: 5, template: { splits: loanSplits("-500") } }]);
    expect(result.bills[0]).toMatchObject({
      accountKey: "acct-6",
      amount: -500,
      isTransfer: true,
      transferAccountKey: "acct-8",
      categoryHandle: null,
      splits: [],
    });
    expect(result.warnings.map((w) => w.code)).toEqual([
      "loanScheduleSimplified",
    ]);
  });

  it("uses the loan's periodic payment when the payment split is itself auto-calc", () => {
    const result = run([
      {
        type: 5,
        template: {
          splits: [
            { account: "CHK", value: "autoCalc" },
            { account: "LOAN", value: "autoCalc" },
          ],
        },
      },
    ]);
    expect(result.bills[0]).toMatchObject({
      amount: -250,
      transferAccountKey: "acct-8",
    });
  });

  it("recognises a loan payment by an auto-calc split whatever the schedule type", () => {
    expect(
      run([{ type: 1, template: { splits: loanSplits("-500") } }]).bills[0]
        .isTransfer,
    ).toBe(true);
    expect(
      run([
        {
          type: 5,
          template: {
            splits: [
              { account: "CHK", value: "-500" },
              { account: "LOAN", value: "500" },
            ],
          },
        },
      ]).bills[0],
    ).toMatchObject({ amount: -500, transferAccountKey: "acct-8" });
  });

  it("is unusable with no periodic payment, no loan account or an excluded payment account", () => {
    const noPayment = rawFile({
      accounts: [
        rawAccount({ id: "CHK", name: "Checking", type: 1 }),
        rawAccount({ id: "LOAN", name: "Loan", type: 5 }),
      ],
      schedules: [
        rawSchedule({
          type: 5,
          template: {
            splits: [
              { account: "CHK", value: "autoCalc" },
              { account: "LOAN", value: "autoCalc" },
            ],
          },
        }),
        rawSchedule({
          type: 5,
          template: { splits: [{ account: "CHK", value: "-5" }] },
        }),
      ],
    });
    const result = mapKmySchedules(harness(noPayment).context, "2024-01-01");
    expect(result.bills).toEqual([]);
    expect(result.warnings.map((w) => w.code)).toEqual([
      "unusableBill",
      "unusableBill",
    ]);
    const excluded = run(
      [{ type: 5, template: { splits: loanSplits("-500") } }],
      {
        options: {
          accounts: [{ handle: 6, include: false, currencyOverride: null }],
        },
      },
    );
    expect(excluded.warnings.map((w) => w.code)).toEqual(["unusableBill"]);
  });

  it("leaves a loan the file has but the wizard excluded as a plain bill without a transfer", () => {
    const result = run(
      [{ type: 5, template: { splits: loanSplits("-500") } }],
      {
        options: {
          accounts: [{ handle: 8, include: false, currencyOverride: null }],
        },
      },
    );
    expect(result.bills[0]).toMatchObject({
      isTransfer: false,
      transferAccountKey: null,
    });
  });
});
