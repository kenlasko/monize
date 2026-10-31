import { DataSource } from "typeorm";
import { InternalServerErrorException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { CashFlowSankeyService } from "./cash-flow-sankey.service";
import { ReportCurrencyService } from "./report-currency.service";
import { Category } from "../categories/entities/category.entity";
import { UserPreference } from "../users/entities/user-preference.entity";
import { ExchangeRateService } from "../currencies/exchange-rate.service";
import * as assembly from "./cash-flow-sankey-assembly";
import {
  assertClosingIdentity,
  classifyCounterpart,
  SankeyIdentityError,
} from "./cash-flow-sankey-assembly";
import type { CashFlowSankeyResponse } from "./dto";
import {
  createScopedDbMocks,
  DataSourceMock,
  ManagerMock,
} from "../test-helpers/scoped-db-testing";

jest.mock("../common/db/scoped-db", () =>
  jest.requireActual("../test-helpers/scoped-db-testing").scopedDbMockModule(),
);

const USER = "user-1";
const CHEQUING = "11111111-1111-4111-8111-111111111111";
const US_CHEQUING = "22222222-2222-4222-8222-222222222222";
const SAVINGS = "33333333-3333-4333-8333-333333333333";
const MORTGAGE = "44444444-4444-4444-8444-444444444444";

function category(
  id: string,
  name: string,
  overrides: Partial<Category> = {},
): Category {
  return {
    id,
    userId: USER,
    parentId: null,
    parent: null,
    children: [],
    name,
    description: null,
    icon: null,
    color: null,
    isIncome: false,
    autoSign: null,
    isSystem: false,
    createdAt: new Date("2026-01-01"),
    ...overrides,
  };
}

const SALARY = category("cat-salary", "Salary", { isIncome: true });
const GROCERIES = category("cat-groceries", "Groceries", { color: "#00aa00" });
const INTEREST = category("cat-interest", "Interest");
const DINING = category("cat-dining", "Dining");

interface CategorizedFixture {
  category_id: string | null;
  currency_code?: string;
  tx_date?: string;
  own_rate?: string | null;
  positive?: string;
  negative?: string;
}

interface TransferFixture {
  counterpart_managed_purpose?: string | null;
  counterpart_account_id: string | null;
  counterpart_type: string | null;
  counterpart_name?: string | null;
  currency_code?: string;
  tx_date?: string;
  own_rate?: string | null;
  inflow?: string;
  outflow?: string;
}

interface RateFixture {
  from_currency: string;
  to_currency: string;
  rate: string;
  rate_date: string;
}

interface Ledger {
  scope?: string[];
  categorized?: CategorizedFixture[];
  whole?: TransferFixture[];
  split?: TransferFixture[];
  rates?: RateFixture[];
}

const categorizedRow = (row: CategorizedFixture) => ({
  currency_code: "CAD",
  tx_date: "2026-09-05",
  own_rate: null,
  positive: "0",
  negative: "0",
  ...row,
});

const transferRow = (row: TransferFixture) => ({
  counterpart_name: "Counterpart",
  currency_code: "CAD",
  tx_date: "2026-09-05",
  own_rate: null,
  inflow: "0",
  outflow: "0",
  ...row,
});

describe("CashFlowSankeyService", () => {
  let scopedManager: ManagerMock;
  let scopedDataSource: DataSourceMock;
  let service: CashFlowSankeyService;
  let categoriesRepository: Record<string, jest.Mock>;
  let userPreferenceRepository: Record<string, jest.Mock>;

  /** Routes each statement the service issues to the ledger's rows. */
  function useLedger(ledger: Ledger): void {
    scopedManager.query.mockImplementation((sql: string) => {
      if (sql.includes("SELECT id FROM accounts")) {
        return Promise.resolve(
          (ledger.scope ?? [CHEQUING]).map((id) => ({ id })),
        );
      }
      if (sql.includes("WITH pairs AS")) {
        return Promise.resolve(ledger.rates ?? []);
      }
      if (sql.includes("LEFT JOIN transactions lt")) {
        return Promise.resolve((ledger.whole ?? []).map(transferRow));
      }
      if (sql.includes("ts.transfer_account_id IS NOT NULL")) {
        return Promise.resolve((ledger.split ?? []).map(transferRow));
      }
      if (sql.includes("COALESCE(ts.category_id, t.category_id)")) {
        return Promise.resolve((ledger.categorized ?? []).map(categorizedRow));
      }
      return Promise.resolve([]);
    });
  }

  const statements = (): Array<[string, unknown[]]> =>
    scopedManager.query.mock.calls.map(
      (call) => [call[0], call[1]] as [string, unknown[]],
    );

  const node = (result: CashFlowSankeyResponse, id: string) =>
    result.nodes.find((n) => n.id === id);

  const link = (
    result: CashFlowSankeyResponse,
    source: string,
    target: string,
  ) => result.links.find((l) => l.source === source && l.target === target);

  beforeEach(async () => {
    categoriesRepository = {
      find: jest.fn().mockResolvedValue([SALARY, GROCERIES, INTEREST, DINING]),
    };
    userPreferenceRepository = {
      findOne: jest.fn().mockResolvedValue({ defaultCurrency: "CAD" }),
    };
    ({ manager: scopedManager, dataSource: scopedDataSource } =
      createScopedDbMocks([
        [Category, categoriesRepository as never],
        [UserPreference, userPreferenceRepository as never],
      ]));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CashFlowSankeyService,
        ReportCurrencyService,
        { provide: ExchangeRateService, useValue: {} },
        { provide: DataSource, useValue: scopedDataSource },
      ],
    }).compile();

    service = module.get(CashFlowSankeyService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * Design section 8, the numerical example. Row 7 (Dining, 50.00 USD) sits in
   * a USD chequing account inside the scope, since a row's currency is its
   * account's.
   */
  it("keeps settlement advances and repayments outside savings", async () => {
    useLedger({
      whole: [
        {
          counterpart_account_id: SAVINGS,
          counterpart_type: "OTHER",
          counterpart_managed_purpose: "SHARED_SETTLEMENT",
          counterpart_name: "Trip settlement",
          inflow: "100",
          outflow: "-300",
        },
      ],
    });
    const result = await service.getCashFlowSankey(
      USER,
      "2026-09-01",
      "2026-09-30",
    );
    expect(result.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "class:shared_settlements", total: 300 }),
        expect.objectContaining({
          id: "inflow:shared_settlements",
          total: 100,
        }),
      ]),
    );
    expect(
      result.nodes.some(
        (node) => node.id === "class:savings" || node.id === "inflow:savings",
      ),
    ).toBe(false);
    expect(result.totals).toMatchObject({
      income: 0,
      expenses: 0,
      inflows: 100,
      outflows: 300,
      deficit: 200,
    });
    expect(classifyCounterpart("OTHER", "SHARED_SETTLEMENT")).toBe(
      "shared_settlements",
    );
    expect(classifyCounterpart("OTHER")).toBe("savings");
  });

  const EXAMPLE: Ledger = {
    scope: [CHEQUING, US_CHEQUING],
    categorized: [
      { category_id: SALARY.id, positive: "5000.0000" },
      { category_id: GROCERIES.id, positive: "20.0000", negative: "-620.0000" },
      { category_id: INTEREST.id, negative: "-700.0000" },
      { category_id: null, negative: "-45.0000" },
      {
        category_id: DINING.id,
        currency_code: "USD",
        tx_date: "2026-09-10",
        negative: "-50.0000",
      },
    ],
    split: [
      {
        counterpart_account_id: MORTGAGE,
        counterpart_type: "MORTGAGE",
        counterpart_name: "Mortgage",
        outflow: "-900.0000",
      },
    ],
    whole: [
      {
        counterpart_account_id: SAVINGS,
        counterpart_type: "SAVINGS",
        counterpart_name: "Savings",
        outflow: "-1000.0000",
      },
    ],
    rates: [
      {
        from_currency: "CAD",
        to_currency: "USD",
        rate: "0.7407407407",
        rate_date: "2026-09-01",
      },
    ],
  };

  describe("the numerical example (design section 8)", () => {
    it("draws every node at its netted figure and closes on the residual", async () => {
      useLedger({
        ...EXAMPLE,
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate: "1.3500000000",
            rate_date: "2026-09-01",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `income:${SALARY.id}`)?.total).toBe(5000);
      expect(node(result, `expense:${GROCERIES.id}`)?.total).toBe(600);
      expect(node(result, `expense:${INTEREST.id}`)?.total).toBe(700);
      expect(node(result, `expense:${DINING.id}`)?.total).toBe(67.5);
      expect(node(result, "uncategorized:expense")?.total).toBe(45);
      expect(node(result, "class:debt")?.total).toBe(900);
      expect(node(result, "class:savings")?.total).toBe(1000);
      expect(node(result, "residual:unspent")?.total).toBe(1687.5);
      expect(node(result, "residual:deficit")).toBeUndefined();

      expect(result.totals).toEqual({
        income: 5000,
        inflows: 0,
        expenses: 1412.5,
        outflows: 1900,
        unspent: 1687.5,
        deficit: 0,
      });
      // SANKEY-001: 5000 + 0 + 0 = 1412.50 + 1900 + 1687.50.
      const t = result.totals;
      expect(t.income! + t.inflows! + t.deficit!).toBeCloseTo(
        t.expenses! + t.outflows! + t.unspent!,
        10,
      );
      expect(result.missingCurrencies).toEqual([]);
      expect(result.excludedCount).toBe(0);
      expect(result.scopeAccountIds).toEqual([CHEQUING, US_CHEQUING]);
      expect(result.currency).toBe("CAD");
    });

    it("nulls the Dining link, the expenses total and the residual without the USD rate (SANKEY-004)", async () => {
      useLedger({ ...EXAMPLE, rates: [] });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      const dining = node(result, `expense:${DINING.id}`);
      expect(dining?.total).toBeNull();
      expect(dining?.knownTotal).toBe(0);
      expect(link(result, "hub", `expense:${DINING.id}`)?.amount).toBeNull();
      expect(result.totals.expenses).toBeNull();
      expect(result.knownTotals.expenses).toBe(1345);
      // The other sides converted: a gap on one does not blank them.
      expect(result.totals.income).toBe(5000);
      expect(result.totals.outflows).toBe(1900);
      expect(result.totals.unspent).toBeNull();
      expect(result.totals.deficit).toBeNull();
      expect(node(result, "residual:unspent")?.total).toBeNull();
      expect(node(result, "hub")?.total).toBeNull();
      expect(result.missingCurrencies).toEqual(["USD"]);
      expect(result.excludedCount).toBe(1);
    });

    it("converts at the rate on the row's own date, never one struck after it (INV-FX-001)", async () => {
      useLedger({
        ...EXAMPLE,
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate: "1.3000000000",
            rate_date: "2026-09-01",
          },
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate: "1.5000000000",
            rate_date: "2026-09-20",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `expense:${DINING.id}`)?.total).toBe(65);
    });

    it("treats a rate older than the age bound as missing", async () => {
      useLedger({
        ...EXAMPLE,
        rates: [
          {
            from_currency: "USD",
            to_currency: "CAD",
            rate: "1.3500000000",
            rate_date: "2026-06-01",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `expense:${DINING.id}`)?.total).toBeNull();
      expect(result.missingCurrencies).toEqual(["USD"]);
    });

    it("converts a row at its own rate when it reaches the reporting currency (INV-FX-002)", async () => {
      useLedger({
        scope: [US_CHEQUING],
        categorized: [
          {
            category_id: DINING.id,
            currency_code: "USD",
            // 0.74 USD per CAD: 74.00 USD paid 100.00 CAD.
            own_rate: "0.7400000000",
            negative: "-74.0000",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `expense:${DINING.id}`)?.total).toBe(100);
      expect(result.missingCurrencies).toEqual([]);
      // The market history was never asked for: the row's rate answered.
      expect(statements().some(([sql]) => sql.includes("WITH pairs AS"))).toBe(
        false,
      );
    });
  });

  describe("truth table A: the residual", () => {
    it.each([
      ["5000.0000", "-4200.0000", 800, 0],
      ["5000.0000", "-5000.0000", 0, 0],
      ["5000.0000", "-5600.0000", 0, 600],
    ])(
      "income %s against spending %s leaves unspent %d and deficit %d",
      async (income, spent, unspent, deficit) => {
        useLedger({
          categorized: [
            { category_id: SALARY.id, positive: income },
            { category_id: GROCERIES.id, negative: spent },
          ],
        });

        const result = await service.getCashFlowSankey(
          USER,
          "2026-09-01",
          "2026-09-30",
        );

        expect(result.totals.unspent).toBe(unspent);
        expect(result.totals.deficit).toBe(deficit);
        expect(node(result, "residual:unspent")?.total ?? 0).toBe(unspent);
        expect(node(result, "residual:deficit")?.total ?? 0).toBe(deficit);
        if (deficit > 0) {
          expect(link(result, "residual:deficit", "hub")?.amount).toBe(deficit);
        }
        if (unspent > 0) {
          expect(link(result, "hub", "residual:unspent")?.amount).toBe(unspent);
        }
      },
    );
  });

  describe("truth table B: transfer leg classification", () => {
    it.each([
      ["SAVINGS", "savings"],
      ["INVESTMENT", "savings"],
      ["ASSET", "savings"],
      ["OTHER", "savings"],
      ["LOAN", "debt"],
      ["MORTGAGE", "debt"],
      ["LINE_OF_CREDIT", "debt"],
      ["CHEQUING", "other_accounts"],
      ["CASH", "other_accounts"],
      // Decision 5 / K2: a card payment is never a debt flow.
      ["CREDIT_CARD", "other_accounts"],
      [null, "other_accounts"],
    ])("a %s counterpart is %s", (type, expected) => {
      expect(classifyCounterpart(type)).toBe(expected);
    });

    it("lands each leg on its class by sign, never in income or expenses (INV-REPORT-003)", async () => {
      useLedger({
        whole: [
          {
            counterpart_account_id: SAVINGS,
            counterpart_type: "SAVINGS",
            outflow: "-100.0000",
          },
          {
            counterpart_account_id: "inv",
            counterpart_type: "INVESTMENT",
            outflow: "-50.0000",
          },
          {
            counterpart_account_id: "chq2",
            counterpart_type: "CHEQUING",
            outflow: "-30.0000",
          },
          {
            counterpart_account_id: SAVINGS,
            counterpart_type: "SAVINGS",
            inflow: "200.0000",
          },
          {
            counterpart_account_id: "loc",
            counterpart_type: "LINE_OF_CREDIT",
            inflow: "70.0000",
          },
          {
            counterpart_account_id: "cc",
            counterpart_type: "CREDIT_CARD",
            inflow: "10.0000",
          },
        ],
        split: [
          {
            counterpart_account_id: MORTGAGE,
            counterpart_type: "MORTGAGE",
            outflow: "-900.0000",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, "class:savings")?.total).toBe(150);
      expect(node(result, "class:debt")?.total).toBe(900);
      expect(node(result, "class:other_accounts")?.total).toBe(30);
      expect(node(result, "inflow:savings")?.total).toBe(200);
      expect(node(result, "inflow:borrowed")?.total).toBe(70);
      expect(node(result, "inflow:other_accounts")?.total).toBe(10);
      expect(result.totals.income).toBe(0);
      expect(result.totals.expenses).toBe(0);
      expect(result.totals.outflows).toBe(1080);
      expect(result.totals.inflows).toBe(280);
      expect(result.totals.deficit).toBe(800);
    });

    it("reads only legs whose counterpart is out of scope, so an internal transfer is invisible (SANKEY-002)", async () => {
      useLedger({ scope: [CHEQUING, SAVINGS] });

      await service.getCashFlowSankey(USER, "2026-09-01", "2026-09-30");

      const whole = statements().find(([sql]) =>
        sql.includes("LEFT JOIN transactions lt"),
      )!;
      const split = statements().find(([sql]) =>
        sql.includes("ts.transfer_account_id IS NOT NULL"),
      )!;
      expect(whole[0]).toContain("t.account_id = ANY($2::uuid[])");
      expect(whole[0]).toContain("NOT (cp.id = ANY($2::uuid[]))");
      expect(split[0]).toContain("t.account_id = ANY($2::uuid[])");
      expect(split[0]).toContain(
        "NOT (ts.transfer_account_id = ANY($2::uuid[]))",
      );
      expect(whole[1][1]).toEqual([CHEQUING, SAVINGS]);
      expect(split[1][1]).toEqual([CHEQUING, SAVINGS]);
    });

    it("files a leg whose counterpart it cannot see under other accounts, as an unlinked account", async () => {
      useLedger({
        whole: [
          {
            counterpart_account_id: null,
            counterpart_type: null,
            counterpart_name: null,
            outflow: "-25.0000",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
        { depth: 2 },
      );

      expect(node(result, "class:other_accounts")?.total).toBe(25);
      const unlinked = node(result, "account:unlinked");
      expect(unlinked?.label).toBe("(unlinked account)");
      expect(unlinked?.accountId).toBeNull();
      expect(
        link(result, "class:other_accounts", "account:unlinked")?.amount,
      ).toBe(25);
    });
  });

  describe("income and expense rows", () => {
    it("moves a category that nets the other way to the other side", async () => {
      useLedger({
        categorized: [
          // An expense category whose refunds beat its spending.
          {
            category_id: GROCERIES.id,
            positive: "80.0000",
            negative: "-30.0000",
          },
          // An income category whose clawbacks beat its income.
          { category_id: SALARY.id, positive: "10.0000", negative: "-40.0000" },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `income:${GROCERIES.id}`)?.total).toBe(50);
      expect(node(result, `expense:${SALARY.id}`)?.total).toBe(30);
      expect(node(result, `expense:${GROCERIES.id}`)).toBeUndefined();
    });

    it("keeps uncategorized income and spending on their own sides", async () => {
      useLedger({
        categorized: [
          { category_id: null, positive: "15.0000", negative: "-45.0000" },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, "uncategorized:income")?.total).toBe(15);
      expect(node(result, "uncategorized:expense")?.total).toBe(45);
    });

    it("keeps a category that nets to zero as a node without a link", async () => {
      useLedger({
        categorized: [
          {
            category_id: GROCERIES.id,
            positive: "20.0000",
            negative: "-20.0000",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      expect(node(result, `expense:${GROCERIES.id}`)?.total).toBe(0);
      expect(
        result.links.some((l) => l.target === `expense:${GROCERIES.id}`),
      ).toBe(false);
    });

    it("rolls subcategories into their top-level category, and splits them out at depth 2", async () => {
      const food = category("cat-food", "Food");
      const restaurants = category("cat-rest", "Restaurants", {
        parentId: "cat-food",
      });
      const takeout = category("cat-takeout", "Takeout", {
        parentId: "cat-rest",
      });
      const rebates = category("cat-rebates", "Rebates", {
        parentId: "cat-food",
        isIncome: true,
      });
      const groceries = category("cat-food-groc", "Groceries", {
        parentId: "cat-food",
      });
      categoriesRepository.find.mockResolvedValue([
        food,
        restaurants,
        takeout,
        rebates,
        groceries,
      ]);
      const ledger: Ledger = {
        categorized: [
          { category_id: groceries.id, negative: "-100.0000" },
          { category_id: restaurants.id, negative: "-40.0000" },
          // A grandchild rolls into its second-level ancestor.
          { category_id: takeout.id, negative: "-10.0000" },
          { category_id: food.id, negative: "-10.0000" },
          // An income subcategory under an expense parent.
          { category_id: rebates.id, positive: "30.0000" },
        ],
      };

      useLedger(ledger);
      const shallow = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );
      expect(node(shallow, "expense:cat-food")?.total).toBe(130);
      expect(shallow.nodes.some((n) => n.kind === "child")).toBe(false);

      useLedger(ledger);
      const deep = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
        { depth: 2 },
      );
      expect(link(deep, "hub", "expense:cat-food")?.amount).toBe(130);
      expect(
        link(deep, "expense:cat-food", "child:cat-food-groc")?.amount,
      ).toBe(100);
      expect(link(deep, "expense:cat-food", "child:cat-rest")?.amount).toBe(50);
      expect(link(deep, "expense:cat-food", "child:cat-food")?.amount).toBe(10);
      expect(node(deep, "child:cat-food")?.label).toBe("(no subcategory)");
      // The rebate nets the other way, so it flows into its parent and the
      // signed child links still sum to the parent's 130.
      expect(link(deep, "child:cat-rebates", "expense:cat-food")?.amount).toBe(
        30,
      );
      expect(node(deep, "child:cat-rebates")?.parentCategoryId).toBe(
        "cat-food",
      );
    });

    it("lists the counterpart accounts under each class at depth 2", async () => {
      useLedger({
        whole: [
          {
            counterpart_account_id: SAVINGS,
            counterpart_type: "SAVINGS",
            counterpart_name: "Savings",
            outflow: "-100.0000",
          },
          {
            counterpart_account_id: "tfsa",
            counterpart_type: "INVESTMENT",
            counterpart_name: "TFSA",
            outflow: "-50.0000",
          },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
        { depth: 2 },
      );

      expect(link(result, "class:savings", `account:${SAVINGS}`)?.amount).toBe(
        100,
      );
      expect(link(result, "class:savings", "account:tfsa")?.amount).toBe(50);
      expect(node(result, "account:tfsa")?.label).toBe("TFSA");
    });
  });

  describe("scope", () => {
    it("defaults to the open cash-flow accounts of the five types", async () => {
      useLedger({ scope: [CHEQUING, SAVINGS] });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
      );

      const [sql, params] = statements().find(([s]) =>
        s.includes("SELECT id FROM accounts"),
      )!;
      expect(sql).toContain("is_closed = false");
      expect(sql).toContain("account_sub_type IS NULL");
      expect(params).toEqual([
        USER,
        ["CHEQUING", "SAVINGS", "CASH", "CREDIT_CARD", "LINE_OF_CREDIT"],
      ]);
      expect(result.scopeAccountIds).toEqual([CHEQUING, SAVINGS]);
    });

    it("uses the named accounts, closed ones included", async () => {
      useLedger({ scope: [MORTGAGE] });

      const result = await service.getCashFlowSankey(
        USER,
        "2026-09-01",
        "2026-09-30",
        { accountIds: [MORTGAGE] },
      );

      const [sql, params] = statements().find(([s]) =>
        s.includes("SELECT id FROM accounts"),
      )!;
      expect(sql).not.toContain("is_closed");
      expect(params).toEqual([USER, [MORTGAGE]]);
      expect(result.scopeAccountIds).toEqual([MORTGAGE]);
    });

    it("answers an empty scope without reading the ledger", async () => {
      useLedger({ scope: [] });

      const result = await service.getCashFlowSankey(
        USER,
        undefined,
        "2026-09-30",
      );

      expect(result.nodes).toEqual([]);
      expect(result.startDate).toBe("2026-09-30");
      expect(
        statements().some(([sql]) => sql.includes("FROM transactions")),
      ).toBe(false);
    });

    it("opens a window without a start date on its earliest row", async () => {
      useLedger({
        categorized: [
          { category_id: SALARY.id, tx_date: "2026-03-04", positive: "1.0000" },
          { category_id: SALARY.id, tx_date: "2026-01-02", positive: "1.0000" },
        ],
      });

      const result = await service.getCashFlowSankey(
        USER,
        undefined,
        "2026-09-30",
      );

      expect(result.startDate).toBe("2026-01-02");
      const categorized = statements().find(([sql]) =>
        sql.includes("COALESCE(ts.category_id, t.category_id)"),
      )!;
      expect(categorized[0]).not.toContain("t.transaction_date >= $5");
      expect(categorized[1]).toHaveLength(4);
    });
  });

  describe("exclusions (SANKEY-003)", () => {
    it("keeps VOID, investment-linked cash, transfers and asset categories out of the categorized rows", async () => {
      useLedger({});

      await service.getCashFlowSankey(USER, "2026-09-01", "2026-09-30");

      const [sql, params] = statements().find(([s]) =>
        s.includes("COALESCE(ts.category_id, t.category_id)"),
      )!;
      expect(sql).toContain("t.is_transfer = false");
      expect(sql).toContain("t.status != 'VOID'");
      expect(sql).toContain("FROM investment_transactions");
      expect(sql).toContain("ax.asset_category_id");
      expect(sql).toContain("t.transaction_date >= $5");
      expect(params).toEqual([
        USER,
        [CHEQUING],
        "2026-09-30",
        "CAD",
        "2026-09-01",
      ]);
    });
  });

  describe("the closing identity (SANKEY-001)", () => {
    it("refuses links that do not close", () => {
      expect(() =>
        assertClosingIdentity(
          [
            {
              source: "income:a",
              target: "hub",
              knownMinor: 100,
              complete: true,
            },
            {
              source: "hub",
              target: "expense:b",
              knownMinor: 90,
              complete: true,
            },
          ],
          {
            income: 100,
            inflows: 0,
            expenses: 90,
            outflows: 0,
            unspent: 0,
            deficit: 0,
          },
        ),
      ).toThrow(SankeyIdentityError);
    });

    it("refuses a pass-through node that does not balance", () => {
      expect(() =>
        assertClosingIdentity(
          [
            {
              source: "income:a",
              target: "hub",
              knownMinor: 100,
              complete: true,
            },
            {
              source: "hub",
              target: "expense:b",
              knownMinor: 100,
              complete: true,
            },
            {
              source: "expense:b",
              target: "child:c",
              knownMinor: 60,
              complete: true,
            },
          ],
          {
            income: 100,
            inflows: 0,
            expenses: 100,
            outflows: 0,
            unspent: 0,
            deficit: 0,
          },
        ),
      ).toThrow(/does not balance/);
    });

    it("answers a diagram that does not close with a 500, never a drawing", async () => {
      useLedger({});
      jest.spyOn(assembly, "assembleCashFlowSankey").mockImplementation(() => {
        throw new SankeyIdentityError("does not close", 5);
      });

      await expect(
        service.getCashFlowSankey(USER, "2026-09-01", "2026-09-30"),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it("rethrows anything else unchanged", async () => {
      useLedger({});
      const boom = new Error("boom");
      jest.spyOn(assembly, "assembleCashFlowSankey").mockImplementation(() => {
        throw boom;
      });

      await expect(
        service.getCashFlowSankey(USER, "2026-09-01", "2026-09-30"),
      ).rejects.toBe(boom);
    });
  });
});
