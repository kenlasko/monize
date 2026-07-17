import { gunzipSync } from "zlib";
import { BackupService } from "../backup.service";
import { SupportBackupService } from "./support-backup.service";

const USER = "11111111-1111-4111-8111-111111111111";
const ACC1 = "aaaaaaaa-1111-4111-8111-111111111111";
const ACC2 = "aaaaaaaa-2222-4111-8111-111111111111";
const PAY1 = "bbbbbbbb-1111-4111-8111-111111111111";
const CAT1 = "cccccccc-1111-4111-8111-111111111111";
const TX1 = "dddddddd-1111-4111-8111-111111111111";
const TX2 = "dddddddd-2222-4111-8111-111111111111";
const TX3 = "dddddddd-3333-4111-8111-111111111111";
const SP1 = "eeeeeeee-1111-4111-8111-111111111111";
const SP2 = "eeeeeeee-2222-4111-8111-111111111111";
const ACC3 = "aaaaaaaa-3333-4111-8111-111111111111";
const TXV = "dddddddd-4444-4111-8111-111111111111";
const TXM = "dddddddd-5555-4111-8111-111111111111";
const SP3 = "eeeeeeee-3333-4111-8111-111111111111";
const SCH1 = "12121212-1111-4111-8111-111111111111";
const MC1 = "34343434-1111-4111-8111-111111111111";

function fixtureTables(): Record<string, Record<string, unknown>[]> {
  return {
    currencies: [],
    user_preferences: [
      {
        user_id: USER,
        default_currency: "PLN",
        timezone: "Europe/Warsaw",
        last_client_timezone: "Europe/Warsaw",
        language: "pl",
        dashboard_widget_config: { netWorth: { accountIds: [ACC3] } },
      },
    ],
    user_currency_preferences: [],
    categories: [
      {
        id: CAT1,
        user_id: USER,
        name: "Groceries",
        description: "food shopping",
        parent_id: null,
      },
    ],
    payees: [
      {
        id: PAY1,
        user_id: USER,
        name: "Biedronka",
        notes: "local grocery",
        is_active: true,
      },
    ],
    payee_aliases: [],
    institutions: [],
    accounts: [
      {
        id: ACC1,
        user_id: USER,
        account_type: "CHEQUING",
        name: "Everyday Chequing",
        description: "my main account",
        currency_code: "PLN",
        account_number: "PL60102010260000042270201111",
        opening_balance: 100,
        current_balance: 999,
        interest_rate: 5,
        linked_account_id: null,
      },
      {
        id: ACC2,
        user_id: USER,
        account_type: "SAVINGS",
        name: "Rainy Day",
        description: null,
        currency_code: "PLN",
        account_number: null,
        opening_balance: 0,
        current_balance: 500,
        interest_rate: 3,
        linked_account_id: null,
      },
      {
        id: ACC3,
        user_id: USER,
        account_type: "SAVINGS",
        name: "Outside",
        description: null,
        currency_code: "PLN",
        account_number: null,
        opening_balance: 0,
        current_balance: 0,
        interest_rate: 1,
        linked_account_id: null,
      },
    ],
    tags: [],
    transactions: [
      {
        id: TX1,
        user_id: USER,
        account_id: ACC1,
        transaction_date: "2026-01-01",
        payee_id: PAY1,
        payee_name: "Biedronka",
        category_id: CAT1,
        amount: 100,
        currency_code: "PLN",
        exchange_rate: 1,
        description: "ODSETKI: 388,14",
        reference_number: "REF-000123",
        is_split: false,
      },
      {
        id: TX2,
        user_id: USER,
        account_id: ACC1,
        transaction_date: "2026-01-02",
        payee_id: null,
        payee_name: null,
        category_id: null,
        amount: 50,
        currency_code: "PLN",
        exchange_rate: 1,
        description: null,
        reference_number: null,
        is_split: true,
      },
      {
        id: TXV,
        user_id: USER,
        account_id: ACC1,
        transaction_date: "2026-01-05",
        payee_id: null,
        payee_name: null,
        category_id: null,
        amount: 40,
        currency_code: "PLN",
        exchange_rate: 1,
        description: null,
        reference_number: null,
        is_split: false,
        status: "VOID",
      },
      {
        id: TXM,
        user_id: USER,
        account_id: ACC2,
        transaction_date: "2026-01-02",
        payee_id: null,
        payee_name: null,
        category_id: null,
        amount: 10,
        currency_code: "PLN",
        exchange_rate: 1,
        description: null,
        reference_number: null,
        is_split: false,
        is_transfer: true,
      },
      {
        id: TX3,
        user_id: USER,
        account_id: ACC2,
        transaction_date: "2026-01-03",
        payee_id: null,
        payee_name: null,
        category_id: null,
        amount: 500,
        currency_code: "PLN",
        exchange_rate: 1,
        description: null,
        reference_number: null,
        is_split: false,
      },
    ],
    transaction_splits: [
      {
        id: SP3,
        transaction_id: TX2,
        kind: "transfer",
        category_id: null,
        transfer_account_id: ACC2,
        linked_transaction_id: TXM,
        amount: 10,
        memo: "to savings",
      },
      {
        id: SP1,
        transaction_id: TX2,
        kind: "category",
        category_id: CAT1,
        amount: 30,
        memo: "part a",
      },
      {
        id: SP2,
        transaction_id: TX2,
        kind: "category",
        category_id: CAT1,
        amount: 20,
        memo: "part b",
      },
    ],
    transaction_tags: [],
    transaction_split_tags: [],
    scheduled_transactions: [
      {
        id: SCH1,
        user_id: USER,
        account_id: ACC1,
        name: "Monthly move",
        amount: 25,
        currency_code: "PLN",
        frequency: "MONTHLY",
        next_due_date: "2026-08-01",
        start_date: "2026-01-01",
        is_transfer: true,
        transfer_account_id: ACC3,
        investment_funding_account_id: null,
        investment_security_id: null,
      },
    ],
    scheduled_transaction_splits: [],
    scheduled_transaction_overrides: [],
    scheduled_transaction_split_tags: [],
    securities: [],
    security_prices: [],
    holdings: [],
    investment_transactions: [],
    loan_rate_changes: [],
    loan_scenarios: [],
    security_tags: [],
    budgets: [
      {
        id: "ffffffff-1111-4111-8111-111111111111",
        user_id: USER,
        name: "Monthly",
        description: "d",
        base_income: 1000,
        currency_code: "PLN",
        config: { includeTransfers: false },
      },
    ],
    budget_categories: [],
    budget_periods: [],
    budget_period_categories: [],
    budget_alerts: [],
    custom_reports: [],
    investment_reports: [],
    import_column_mappings: [],
    monthly_account_balances: [],
    auto_backup_settings: [],
    ai_provider_configs: [
      {
        id: "99999999-1111-4111-8111-111111111111",
        user_id: USER,
        api_key_enc: "SECRET-KEY",
        provider: "anthropic",
      },
    ],
    monte_carlo_scenarios: [
      {
        id: MC1,
        user_id: USER,
        name: "Retire",
        description: null,
        account_ids: [ACC1, ACC2, ACC3],
        starting_value: 1000,
        annual_contribution: 100,
        annual_withdrawal: 0,
        target_value: null,
        expected_return: 0.05,
        volatility: 0.1,
        inflation_rate: 0.02,
      },
    ],
    monte_carlo_cash_flows: [],
  };
}

function makeService(tables = fixtureTables()): SupportBackupService {
  const backup = {
    collectRawExport: jest.fn().mockResolvedValue({
      version: 1,
      exportedAt: "2026-07-17T00:00:00.000Z",
      tables,
    }),
  } as unknown as BackupService;
  return new SupportBackupService(backup);
}

async function generateParsed(
  service: SupportBackupService,
  opts: Parameters<SupportBackupService["generate"]>[1],
): Promise<Record<string, any>> {
  const { buffer, encrypted } = await service.generate(USER, opts);
  expect(encrypted).toBe(false);
  return JSON.parse(gunzipSync(buffer).toString("utf-8"));
}

describe("SupportBackupService.generate", () => {
  it("masks names, drops free text, scales private amounts, keeps public values", async () => {
    const data = await generateParsed(makeService(), { multiplier: 2.5 });

    const acc = data.accounts.find((a: any) => a.opening_balance === 250);
    expect(acc.name).toBe("Ev*************ng");
    expect(acc.description).toBeNull();
    expect(acc.account_number).toBeNull();
    expect(acc.interest_rate).toBe(5); // public rate untouched
    expect(acc.currency_code).toBe("PLN");

    const payee = data.payees[0];
    expect(payee.name).toBe("Bi*****ka");
    expect(payee.notes).toBeNull();

    const tx1 = data.transactions.find(
      (t: any) => t.transaction_date === "2026-01-01",
    );
    expect(tx1.amount).toBe(250);
    expect(tx1.payee_name).toBe("Bi*****ka");
    expect(tx1.description).toBeNull();
    expect(tx1.reference_number).toBeNull();
    expect(tx1.exchange_rate).toBe(1);

    // de-identification marker + timezone constant
    expect(data.supportBackup).toBe(true);
    expect(data.user_preferences[0].timezone).toBe("UTC");
    expect(data.user_preferences[0].last_client_timezone).toBeNull();
  });

  it("reconciles split parents and balances from scaled values, excluding VOID rows", async () => {
    const data = await generateParsed(makeService(), { multiplier: 2.5 });
    const splitParent = data.transactions.find((t: any) => t.is_split === true);
    // splits scaled 10->25, 30->75, 20->50; parent becomes their sum
    expect(splitParent.amount).toBe(150);
    // balance = scaled opening (250) + scaled tx (250) + split parent (150);
    // the VOID transaction (40 -> 100) must NOT count, matching the app
    const acc = data.accounts.find((a: any) => a.opening_balance === 250);
    expect(acc.current_balance).toBe(650);
  });

  it("remaps every id and the user id while preserving referential integrity", async () => {
    const data = await generateParsed(makeService(), { multiplier: 2.5 });
    const acc = data.accounts[0];
    expect(acc.id).not.toBe(ACC1);
    expect(acc.user_id).not.toBe(USER);
    // all rows share the one fresh user id
    expect(data.payees[0].user_id).toBe(acc.user_id);
    // FK still points at the remapped account
    const txForAcc = data.transactions.find(
      (t: any) => t.account_id === acc.id,
    );
    expect(txForAcc).toBeDefined();
  });

  it("excludes disabled sections and always drops ai_provider_configs", async () => {
    const data = await generateParsed(makeService(), {
      multiplier: 2.5,
      sections: [],
    });
    expect(data.budgets).toBeUndefined();
    expect(data.ai_provider_configs).toBeUndefined();
    expect(data.sections).toEqual([]);
    // with all sections, budgets appear but ai config never does
    const full = await generateParsed(makeService(), { multiplier: 2.5 });
    expect(full.budgets).toHaveLength(1);
    expect(full.ai_provider_configs).toBeUndefined();
  });

  it("scopes to the selected account, pulling split-transfer mirrors and shells", async () => {
    const data = await generateParsed(makeService(), {
      multiplier: 2.5,
      accountIds: [ACC1],
    });
    // ACC1 (primary) + ACC2 (shell: split-transfer target), never ACC3
    expect(data.accounts).toHaveLength(2);
    // ACC1's three transactions + the split-transfer mirror leg on ACC2,
    // reached through transaction_splits.linked_transaction_id
    expect(data.transactions).toHaveLength(4);
    expect(
      data.transactions.filter((t: any) => t.is_transfer === true),
    ).toHaveLength(1);
  });

  it("repairs references severed by scoping so the file stays restorable", async () => {
    const data = await generateParsed(makeService(), {
      multiplier: 2.5,
      accountIds: [ACC1],
    });
    // The scheduled transfer to out-of-scope ACC3 survives with its dangling
    // transfer_account_id cleared instead of pointing at a missing account
    expect(data.scheduled_transactions).toHaveLength(1);
    expect(data.scheduled_transactions[0].transfer_account_id).toBeNull();
    // Monte Carlo account_ids are filtered to accounts present in the file
    expect(data.monte_carlo_scenarios[0].account_ids).toHaveLength(2);
    // Dashboard widget config (free-form JSON with account ids) is reset
    expect(data.user_preferences[0].dashboard_widget_config).toEqual({});
    // ...and the excluded account's real UUID appears nowhere in the payload
    expect(JSON.stringify(data)).not.toContain(ACC3);
  });

  it("trims to a date range and shifts opening balances by the removed history", async () => {
    const data = await generateParsed(makeService(), {
      multiplier: 2.5,
      dateFrom: "2026-01-02",
    });
    // TX1 (2026-01-01, 100) is trimmed; its amount moves into the opening
    expect(
      data.transactions.some((t: any) => t.transaction_date === "2026-01-01"),
    ).toBe(false);
    const acc = data.accounts.find((a: any) => a.opening_balance === 500);
    expect(acc).toBeDefined();
    // balance = shifted+scaled opening (500) + split parent (150); VOID excluded
    expect(acc.current_balance).toBe(650);
  });

  it("leaks no original name, free text, account number, secret or id", async () => {
    const { buffer } = await makeService().generate(USER, { multiplier: 2.5 });
    const json = gunzipSync(buffer).toString("utf-8");
    for (const secret of [
      "Biedronka",
      "Everyday Chequing",
      "my main account",
      "ODSETKI",
      "PL60102010260000042270201111",
      "REF-000123",
      "local grocery",
      "SECRET-KEY",
      USER,
      ACC1,
      PAY1,
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("encrypts the file when a password is given", async () => {
    const { buffer, encrypted } = await makeService().generate(USER, {
      multiplier: 2.5,
      password: "hunter2-correct-horse",
    });
    expect(encrypted).toBe(true);
    // encrypted output is not raw gzip
    expect(() => gunzipSync(buffer)).toThrow();
  });
});

describe("SupportBackupService.preview", () => {
  it("returns before (real) and after (obfuscated) samples", async () => {
    const { samples } = await makeService().preview(USER, { multiplier: 2.5 });
    const payees = samples.find((s) => s.table === "payees")!;
    expect(payees.before[0].name).toBe("Biedronka");
    expect(payees.after[0].name).toBe("Bi*****ka");
  });
});
