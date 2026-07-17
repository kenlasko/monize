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
    scheduled_transactions: [],
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
    monte_carlo_scenarios: [],
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

  it("reconciles split parents and account balances from the scaled values", async () => {
    const data = await generateParsed(makeService(), { multiplier: 2.5 });
    const splitParent = data.transactions.find((t: any) => t.is_split === true);
    // splits scaled 30->75 and 20->50, parent becomes their sum
    expect(splitParent.amount).toBe(125);
    // balance = scaled opening (250) + scaled tx (250) + split parent (125)
    const acc = data.accounts.find((a: any) => a.opening_balance === 250);
    expect(acc.current_balance).toBe(625);
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

  it("scopes to the selected account and its transactions", async () => {
    const data = await generateParsed(makeService(), {
      multiplier: 2.5,
      accountIds: [ACC1],
    });
    expect(data.accounts).toHaveLength(1);
    // only ACC1's two transactions, not ACC2's
    expect(data.transactions).toHaveLength(2);
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
