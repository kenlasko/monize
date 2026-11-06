import { BadRequestException, PayloadTooLargeException } from "@nestjs/common";
import { gunzipSync } from "zlib";
import { BackupService } from "../backup.service";
import { decryptBackup } from "../backup-crypto.util";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import {
  allocatePseudonymCode,
  randomPseudonymLetter,
  SupportBackupService,
} from "./support-backup.service";
import { CURRENCY_METADATA } from "../../currencies/currency-metadata";

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
const SEC1 = "56565656-1111-4111-8111-111111111111";

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
    securities: [
      {
        id: SEC1,
        user_id: USER,
        symbol: "AAPL",
        name: "Apple Inc",
        security_type: "STOCK",
        currency_code: "USD",
        description: null,
        msn_instrument_id: "a1b2c3",
      },
    ],
    security_prices: [
      {
        id: 1,
        security_id: SEC1,
        price_date: "2026-01-02",
        close_price: 250.12,
        volume: 1000,
      },
    ],
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
    notifications: [],
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

/**
 * The double is typed as the exact subset of `BackupService` this service reads,
 * not `as unknown as BackupService`.
 *
 * That cast hid a real hole: when `generate` started consulting
 * `exportBufferLimitBytes`, the mock had no such member, so the value was
 * `undefined` and `size > undefined` is `false` -- the new ceiling was silently
 * disabled in every test in this file while they all passed. A `Pick` makes tsc
 * demand the member, so the next dependency this service grows is a compile error
 * here rather than a guard that quietly does nothing.
 */
type BackupServiceDouble = Pick<
  BackupService,
  "collectRawExport" | "exportBufferLimitBytes"
>;

/** Generous by default so the ceiling is out of the way unless a test wants it. */
const DEFAULT_TEST_EXPORT_LIMIT = 64 * 1024 * 1024;

function makeService(
  tables = fixtureTables(),
  exportBufferLimitBytes = DEFAULT_TEST_EXPORT_LIMIT,
): SupportBackupService {
  const backup: BackupServiceDouble = {
    collectRawExport: jest.fn().mockResolvedValue({
      version: 1,
      exportedAt: "2026-07-17T00:00:00.000Z",
      tables,
    }),
    exportBufferLimitBytes,
  };
  return new SupportBackupService(backup as BackupService);
}

/** The double, so a test can inspect how the raw export was requested. */
function makeServiceWithSpy(tables = fixtureTables()): {
  service: SupportBackupService;
  collectRawExport: jest.Mock;
} {
  const collectRawExport = jest.fn().mockResolvedValue({
    version: 1,
    exportedAt: "2026-07-17T00:00:00.000Z",
    tables,
  });
  const backup: BackupServiceDouble = {
    collectRawExport,
    exportBufferLimitBytes: DEFAULT_TEST_EXPORT_LIMIT,
  };
  return {
    service: new SupportBackupService(backup as BackupService),
    collectRawExport,
  };
}

/**
 * The password every fixture here uses. It is not optional: `generate` refuses
 * to produce an unencrypted support backup, so a helper that omitted it was
 * exercising a branch no HTTP caller could reach -- and asserting the output was
 * plain gzip, which is the opposite of the file's stated guarantee.
 */
const FIXTURE_PASSWORD = "fixture-password-not-a-secret";

async function generateParsed(
  service: SupportBackupService,
  opts: Omit<Parameters<SupportBackupService["generate"]>[1], "password"> & {
    password?: string;
  },
): Promise<Record<string, any>> {
  const { buffer, encrypted } = await service.generate(USER, {
    password: FIXTURE_PASSWORD,
    ...opts,
  });
  expect(encrypted).toBe(true);
  const gzipped = await decryptBackup(
    buffer,
    opts.password ?? FIXTURE_PASSWORD,
  );
  return JSON.parse(gunzipSync(gzipped).toString("utf-8"));
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
    // Decrypt and decompress first. Scanning the shipped bytes directly would
    // pass for the wrong reason -- ciphertext contains nothing legible, so the
    // assertion would hold even if every mask were removed. The claim is about
    // the plaintext inside the file, so the plaintext is what gets scanned.
    const { buffer } = await makeService().generate(USER, {
      multiplier: 2.5,
      password: FIXTURE_PASSWORD,
    });
    const json = gunzipSync(
      await decryptBackup(buffer, FIXTURE_PASSWORD),
    ).toString("utf-8");
    // Guard against the scan becoming vacuous: the plaintext must at least look
    // like the export it claims to be searching.
    expect(json).toContain('"supportBackup":true');
    expect(json.length).toBeGreaterThan(1000);
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

  it("excludes the price history unless explicitly opted in", async () => {
    const withoutPrices = await generateParsed(makeService(), {
      multiplier: 2.5,
    });
    expect(withoutPrices.security_prices).toBeUndefined();
    // the security itself stays (masked), only its price series is withheld
    expect(withoutPrices.securities[0].symbol).toBe("****");

    const withPrices = await generateParsed(makeService(), {
      multiplier: 2.5,
      includePriceHistory: true,
    });
    expect(withPrices.security_prices).toHaveLength(1);
    // public price values are untouched even when included
    expect(withPrices.security_prices[0].close_price).toBe(250.12);
  });

  /**
   * The DTO requires a password, so no HTTP caller reaches this. The branch that
   * returned plain gzip when one was absent existed anyway, which put the "never
   * ships in the clear" guarantee at the edge rather than in the thing that
   * produces the file -- and 17 tests in this suite were exercising it, asserting
   * `encrypted: false` on output the API cannot emit.
   */
  it.each([
    ["omitted", undefined],
    ["empty", ""],
  ])(
    "refuses to produce an unencrypted file when the password is %s",
    async (_label, password) => {
      await expect(
        makeService().generate(USER, {
          multiplier: 2.5,
          password: password as string,
        }),
      ).rejects.toThrow(BadRequestException);
    },
  );

  /**
   * The support path holds more copies of the dataset at once than any other
   * export -- raw tables, scoped copy, obfuscated copy, currency-rewritten copy,
   * remapped copy, a JSON string, a Buffer of it, then the gzip output -- and it
   * had no ceiling at all while the buffered export had one. It cannot stream,
   * because reconciling scaled balances needs every table together, so the
   * ceiling is the only thing between a large dataset and an OOM-killed pod that
   * leaves no artifact and no readable error.
   */
  /**
   * A budget checked after the allocation is a budget checked too late.
   *
   * `collectRawExport` ran every table query, including `attachment_blobs`, which
   * is base64: thirty 10 MiB receipts are roughly 400 MiB of text -- the whole of
   * the chart's default backend limit -- fetched, held, and then discarded, because
   * `ALWAYS_EXCLUDED_TABLES` drops the table afterwards. No ceiling could help,
   * because the ceiling is consulted after the load.
   */
  it("never asks the database for tables it always excludes", async () => {
    const { service, collectRawExport } = makeServiceWithSpy();

    await service.generate(USER, {
      multiplier: 2.5,
      password: FIXTURE_PASSWORD,
    });

    expect(collectRawExport).toHaveBeenCalledTimes(1);
    const [, options] = collectRawExport.mock.calls[0];
    expect(options?.skipTables).toBeDefined();
    for (const table of [
      "attachment_blobs",
      "transaction_attachments",
      "ai_provider_configs",
    ]) {
      expect(options.skipTables.has(table)).toBe(true);
    }
  });

  it("skips the same tables for a preview", async () => {
    // The preview shares the cache, so a preview that loaded the blobs would
    // hand the following generate a payload it had already paid for.
    const { service, collectRawExport } = makeServiceWithSpy();

    await service.preview(USER, { multiplier: 2.5 });

    const [, options] = collectRawExport.mock.calls[0];
    expect(options?.skipTables?.has("attachment_blobs")).toBe(true);
  });

  it("refuses a payload above the export ceiling", async () => {
    const tiny = 200; // bytes -- below even the envelope
    await expect(
      makeService(fixtureTables(), tiny).generate(USER, {
        multiplier: 2.5,
        password: FIXTURE_PASSWORD,
      }),
    ).rejects.toThrow(PayloadTooLargeException);
  });

  it("says how large it was and how to narrow it", async () => {
    // "Too large" with no number and no next step makes the user guess which of
    // the three levers to pull.
    await expect(
      makeService(fixtureTables(), 200).generate(USER, {
        multiplier: 2.5,
        password: FIXTURE_PASSWORD,
      }),
    ).rejects.toThrow(/MiB.*limit|account selection|date range/);
  });

  it("produces the file when the payload fits", async () => {
    const { encrypted } = await makeService(
      fixtureTables(),
      DEFAULT_TEST_EXPORT_LIMIT,
    ).generate(USER, { multiplier: 2.5, password: FIXTURE_PASSWORD });
    expect(encrypted).toBe(true);
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

  it("encrypts without ENCRYPTION_KEY (file encryption derives its key from the password, not the AI key)", async () => {
    // The service takes no EncryptionService dependency and encryptBackup
    // derives its AES key from the user's password via scrypt, so an unset
    // ENCRYPTION_KEY cannot affect a support backup. Prove the encrypted
    // path works with no AI key present in the environment.
    const previous = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const { encrypted } = await makeService().generate(USER, {
        multiplier: 2.5,
        password: "correct-horse-battery-staple",
      });
      expect(encrypted).toBe(true);
    } finally {
      if (previous !== undefined) process.env.ENCRYPTION_KEY = previous;
    }
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

/**
 * `currencies.code`, `name` and `symbol` were kept verbatim on the reasoning that
 * the table holds public reference data. For a row a user created, all three are
 * free text -- so a currency called `KEN / Kenneth Lasko Family Credits / KL`
 * travelled unchanged inside an artifact documented as de-identified, beside the
 * masked payee and account names it contradicted.
 */
describe("SupportBackupService custom currencies", () => {
  const MARKER = "Kenneth Lasko";

  function withCustomCurrency(): Record<string, Record<string, unknown>[]> {
    const tables = fixtureTables();
    tables.currencies = [
      {
        code: "KEN",
        name: `${MARKER} Family Credits`,
        symbol: "KL",
        decimal_places: 0,
        is_active: true,
        created_by_user_id: USER,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        code: "PLN",
        name: "Polish Zloty",
        symbol: "zl",
        decimal_places: 2,
        is_active: true,
        created_by_user_id: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ];
    tables.user_currency_preferences = [
      {
        user_id: USER,
        currency_code: "KEN",
        is_active: true,
        created_at: null,
      },
    ];
    tables.accounts = tables.accounts.map((account, index) =>
      index === 0 ? { ...account, currency_code: "KEN" } : account,
    );
    tables.transactions = tables.transactions.map((tx) =>
      tx.account_id === ACC1 ? { ...tx, currency_code: "KEN" } : tx,
    );
    return tables;
  }

  it("removes the user's own words from the code, name and symbol", async () => {
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });

    const custom = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id !== null,
    );
    expect(custom.code).not.toBe("KEN");
    expect(custom.code).toMatch(/^[A-Z]{3}$/);
    expect(custom.name).not.toContain(MARKER);
    expect(custom.symbol).not.toBe("KL");
    // No marker anywhere in the artifact, not just in the row it came from.
    expect(JSON.stringify(data)).not.toContain(MARKER);
    expect(JSON.stringify(data)).not.toContain('"KEN"');
  });

  it("keeps decimal_places, which is the arithmetic", async () => {
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });

    const custom = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id !== null,
    );
    // Changing it would alter what every amount means in a file whose purpose
    // is reproducing a calculation.
    expect(custom.decimal_places).toBe(0);
  });

  it("leaves canonical currencies alone", async () => {
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });

    const canonical = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id === null,
    );
    // Genuinely public. Masking USD would make a reproduction harder to read for
    // no gain.
    expect(canonical).toMatchObject({
      code: "PLN",
      name: "Polish Zloty",
      symbol: "zl",
    });
  });

  it("rewrites every reference so the artifact still restores", async () => {
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });

    const custom = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id !== null,
    );
    const codes = new Set(
      data.currencies.map((c: Record<string, unknown>) => c.code),
    );

    // A reference left pointing at the old code is a foreign-key violation on
    // restore -- the artifact would be de-identified and useless.
    expect(data.user_currency_preferences[0].currency_code).toBe(custom.code);
    for (const account of data.accounts) {
      expect(codes.has(account.currency_code)).toBe(true);
    }
    for (const tx of data.transactions) {
      if (tx.currency_code) expect(codes.has(tx.currency_code)).toBe(true);
    }
  });

  it("does not reuse a code across two exports of the same data", async () => {
    const first = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });
    const second = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });

    const codeOf = (data: Record<string, any>) =>
      data.currencies.find(
        (c: Record<string, unknown>) => c.created_by_user_id !== null,
      ).code;
    // A derived code would let two artifacts from the same user be lined up by
    // it, which is the correlation the identifier remapping exists to prevent.
    expect(codeOf(first)).not.toBe(codeOf(second));
  });

  /**
   * Currencies are shared, and the export deliberately includes every code the
   * user's data references whoever defined it -- so a custom currency another
   * user of the same instance created arrives with *that* user's real UUID in
   * `created_by_user_id`. `currencies` has no `id` column, so the row-id sweep
   * that remaps every other identifier never collects it, and the value would
   * survive verbatim: two support files from two users of one instance could
   * then be lined up by the creator id they share, which is precisely the
   * correlation the remapping step exists to prevent.
   */
  it("carries no other user's id in a shared custom currency", async () => {
    const OTHER_USER = "99999999-9999-4999-8999-999999999999";
    const tables = withCustomCurrency();
    tables.currencies = tables.currencies.map((row) =>
      row.code === "KEN" ? { ...row, created_by_user_id: OTHER_USER } : row,
    );

    const data = await generateParsed(makeService(tables), {
      multiplier: 2.5,
    });

    expect(JSON.stringify(data)).not.toContain(OTHER_USER);
    const custom = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id !== null,
    );
    // Still marked as user-defined rather than canonical -- the distinction is
    // what tells a reader the row is not public reference data, and the restore
    // overwrites the id with the restoring user's anyway.
    expect(custom.created_by_user_id).toBeTruthy();
    expect(custom.created_by_user_id).not.toBe(OTHER_USER);
  });

  it("does not leak the exporting user's own id either", async () => {
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });
    // The fixture's currency is created by USER, and USER is remapped, so this
    // holds for the same reason. Asserted so the fix above cannot be narrowed to
    // "rewrite foreign ids only" and quietly reintroduce the simpler leak.
    expect(JSON.stringify(data)).not.toContain(USER);
  });

  it("never invents a code a real currency claims", async () => {
    // The wiring: one end-to-end export, proving the service reaches the
    // allocator and stores what it returns. The allocation property itself is
    // the next test's -- probing it through `generate` costs two scrypt
    // derivations per sample (~200 ms), which bought twenty samples for four
    // seconds of CPU and sat on the default timeout.
    const data = await generateParsed(makeService(withCustomCurrency()), {
      multiplier: 2.5,
    });
    const custom = data.currencies.find(
      (c: Record<string, unknown>) => c.created_by_user_id !== null,
    );
    // A pseudonym that reads as USD or EUR would be actively misleading to
    // whoever opens the artifact. The `not.toBe("KEN")` keeps this from
    // passing vacuously when nothing is pseudonymised at all.
    expect(custom.code).not.toBe("KEN");
    expect(CURRENCY_METADATA[custom.code]).toBeUndefined();
    expect(custom.code).not.toBe("PLN");
  });

  it("allocates a code no catalogued currency and no taken code claims", () => {
    // 2000 samples rather than twenty, because the allocator is cheap on its
    // own: a rejection bug that fires one time in fifty would survive a
    // twenty-sample end-to-end loop and not this.
    const taken = new Set<string>(["KEN", "PLN"]);
    const issued = new Set<string>();
    for (let run = 0; run < 2000; run += 1) {
      const code = allocatePseudonymCode(taken);
      expect(code).toMatch(/^[A-Z]{3}$/);
      expect(CURRENCY_METADATA[code]).toBeUndefined();
      // `taken` grows as codes are issued, so this also covers the collision
      // path: the same code must never come back twice.
      expect(issued.has(code)).toBe(false);
      issued.add(code);
    }
    expect(issued.has("KEN")).toBe(false);
    expect(issued.has("PLN")).toBe(false);
  });

  /**
   * CodeQL `js/biased-cryptographic-random`.
   *
   * The allocator drew a byte and took `% 26`. 256 is not a multiple of 26, so
   * bytes 0-233 cover the alphabet nine times and 234-255 cover A-V a tenth
   * time: A-V come up 10/256 each and W-Z 9/256, an 11% excess for twenty-two of
   * the twenty-six letters. For a pseudonym whose only job is to be
   * unpredictable, a distribution an attacker can predict is the defect --
   * modest here (the codes are decorrelated per artifact, not secret) and fatal
   * the moment the same helper is reached for by something that is.
   *
   * A distribution test rather than a shape assertion, because the defect was
   * the distribution. 260,000 draws puts the uniform standard error on
   * P(W|X|Y|Z) at ~0.07 percentage points, so the biased path's 14.06% sits
   * about eighteen sigma from the uniform 15.38%; the one-percentage-point
   * tolerance below is fourteen sigma of headroom against a false failure and
   * still refuses the bias outright.
   */
  it("draws each letter uniformly (biased-modulo guard)", () => {
    const DRAWS = 260_000;
    const counts = new Map<string, number>();
    for (let i = 0; i < DRAWS; i += 1) {
      const letter = randomPseudonymLetter();
      counts.set(letter, (counts.get(letter) ?? 0) + 1);
    }

    // Every letter is reachable: a rejection bound off by one would silently
    // retire the tail of the alphabet rather than skew it.
    expect(counts.size).toBe(26);

    // The four letters the biased path under-produced, against the twenty-two it
    // over-produced. Uniform puts them at 4/26; `% 26` on a raw byte puts them
    // at 36/256.
    const tail = ["W", "X", "Y", "Z"].reduce(
      (sum, letter) => sum + (counts.get(letter) ?? 0),
      0,
    );
    expect(tail / DRAWS).toBeCloseTo(4 / 26, 2);

    // And no individual letter drifts either -- the aggregate above would pass a
    // bias that moved letters within each group.
    for (const [, count] of counts) {
      expect(count / DRAWS).toBeGreaterThan(1 / 26 - 0.005);
      expect(count / DRAWS).toBeLessThan(1 / 26 + 0.005);
    }
  });

  /**
   * The half of the rule a scan can hold: `%` applied to bytes straight out of a
   * cryptographic source is biased unless something rejects the tail first.
   *
   * Written as a scan rather than a paragraph because the mistake is mechanical
   * and reads as correct at every individual site -- `bytes[0] % 26` is what
   * anyone writes. Every other crypto random in `src/` goes through
   * `.toString("hex")` or `crypto.randomInt`, both unbiased, so the allowlist
   * has exactly one entry: the function that does the rejection.
   */
  it("never reduces a cryptographic random with % outside the rejection sampler (source guard)", () => {
    const SRC = join(__dirname, "..", "..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return entry.name.endsWith(".ts") && !entry.name.endsWith(".spec.ts")
          ? [full]
          : [];
      });

    /** The one place a `%` may follow a draw, because it rejects the tail first. */
    const REJECTION_SAMPLER = "backup/support-backup/support-backup.service.ts";

    const offenders: string[] = [];
    for (const full of walk(SRC)) {
      const file = relative(SRC, full).split("\\").join("/");
      const lines = readFileSync(full, "utf8").split("\n");
      for (const [index, line] of lines.entries()) {
        if (!/\brandom(Bytes|FillSync)\s*\(/.test(line)) continue;
        // The reduction lands within a few lines of the draw in every shape this
        // has taken; a wider window would sweep in unrelated arithmetic.
        const window = lines.slice(index, index + 4).join("\n");
        // Not a comment, and not a string: an actual modulo operator.
        const reduces = window
          .split("\n")
          .some(
            (text) => !/^\s*(\*|\/\/)/.test(text) && /[^%]%[^%=]/.test(text),
          );
        if (reduces && file !== REJECTION_SAMPLER) {
          offenders.push(`${file}:${index + 1}`);
        }
      }
    }

    // Reach for `crypto.randomInt`, or reject the tail as `randomPseudonymLetter`
    // does. Do not take `%` of a raw byte.
    expect(offenders).toEqual([]);
  });
});

describe("SupportBackupService reconcile precision", () => {
  const BTC_ACC = "aaaaaaaa-b7c0-4111-8111-111111111111";
  const CAD_ACC = "aaaaaaaa-cad0-4111-8111-111111111111";
  const BTC_SPLIT_TX = "dddddddd-b7c1-4111-8111-111111111111";

  type Tables = Record<string, Record<string, unknown>[]>;
  const reconcile = (tables: Tables): Tables =>
    (
      makeService() as unknown as { reconcile: (t: Tables) => Tables }
    ).reconcile(tables);

  const tx = (id: string, account: string, amount: number) => ({
    id,
    account_id: account,
    amount,
    is_split: false,
    status: "UNRECONCILED",
    parent_transaction_id: null,
  });

  const tables = (): Tables => ({
    currencies: [
      { code: "BTC", decimal_places: 8 },
      { code: "CAD", decimal_places: 2 },
    ],
    accounts: [
      {
        id: BTC_ACC,
        currency_code: "BTC",
        opening_balance: 0.00000001,
        current_balance: 0,
      },
      {
        id: CAD_ACC,
        currency_code: "CAD",
        opening_balance: 100,
        current_balance: 0,
      },
    ],
    transactions: [
      tx("t1", BTC_ACC, 0.00000005),
      tx("t2", BTC_ACC, 0.00000003),
      tx("t3", CAD_ACC, 10.1),
      tx("t4", CAD_ACC, 20.2),
    ],
    transaction_splits: [],
  });

  it("sums a coin account at its own eight places", () => {
    const out = reconcile(tables());
    expect(out.accounts[0].current_balance).toBe(0.00000009);
  });

  it("sums a fiat account at four places as before", () => {
    const out = reconcile(tables());
    expect(out.accounts[1].current_balance).toBe(130.3);
  });

  it("sums a coin split parent from its eight-place lines", () => {
    const t = tables();
    t.transactions.push({
      ...tx(BTC_SPLIT_TX, BTC_ACC, 0),
      is_split: true,
    });
    t.transaction_splits = [
      { transaction_id: BTC_SPLIT_TX, amount: 0.00000002 },
      { transaction_id: BTC_SPLIT_TX, amount: 0.00000004 },
    ];
    const out = reconcile(t);
    expect(
      out.transactions.find((row) => row.id === BTC_SPLIT_TX)?.amount,
    ).toBe(0.00000006);
    expect(out.accounts[0].current_balance).toBe(0.00000015);
  });

  it("reads an account whose currency the export lacks as fiat", () => {
    const t = tables();
    t.currencies = [];
    const out = reconcile(t);
    // 0.00000001 + 0.00000005 + 0.00000003 at four places is 0.
    expect(out.accounts[0].current_balance).toBe(0);
    expect(out.accounts[1].current_balance).toBe(130.3);
  });
});

describe("SupportBackupService scaling precision", () => {
  const BTC_ACC = "aaaaaaaa-b7c0-4111-8111-111111111111";
  const USD_ACC = "aaaaaaaa-d0c0-4111-8111-111111111111";
  const BTC_SCH = "12121212-b7c0-4111-8111-111111111111";
  const USD_SCH = "12121212-d0c0-4111-8111-111111111111";
  const BTC_TX = "dddddddd-b7c1-4111-8111-111111111111";
  const USD_TX = "dddddddd-d0c1-4111-8111-111111111111";

  type Tables = Record<string, Record<string, unknown>[]>;
  const obfuscate = (tables: Tables, multiplier: number): Tables =>
    (
      makeService() as unknown as {
        obfuscate: (t: Tables, m: number) => Tables;
      }
    ).obfuscate(tables, multiplier);

  const input = (): Tables => ({
    currencies: [
      { code: "BTC", decimal_places: 8 },
      { code: "USD", decimal_places: 2 },
    ],
    accounts: [
      {
        id: BTC_ACC,
        currency_code: "BTC",
        opening_balance: 0.000025,
        current_balance: 0.000025,
        low_balance_threshold: 0.000012,
        payment_amount: 12.3456,
      },
      {
        id: USD_ACC,
        currency_code: "USD",
        opening_balance: 12.3456,
        current_balance: 12.3456,
      },
    ],
    transactions: [
      {
        id: BTC_TX,
        account_id: BTC_ACC,
        amount: 0.000025,
        is_split: false,
        status: "UNRECONCILED",
      },
      {
        id: USD_TX,
        account_id: USD_ACC,
        amount: 12.3456,
        is_split: false,
        status: "UNRECONCILED",
      },
    ],
    transaction_splits: [
      { id: "s-btc", transaction_id: BTC_TX, amount: 0.000025 },
      { id: "s-usd", transaction_id: USD_TX, amount: 12.3456 },
    ],
    scheduled_transactions: [
      { id: BTC_SCH, account_id: BTC_ACC, amount: 0.000025 },
      { id: USD_SCH, account_id: USD_ACC, amount: 12.3456 },
    ],
    scheduled_transaction_splits: [
      { id: "ss-btc", scheduled_transaction_id: BTC_SCH, amount: 0.000025 },
      { id: "ss-usd", scheduled_transaction_id: USD_SCH, amount: 12.3456 },
    ],
    scheduled_transaction_overrides: [
      {
        id: "o-btc",
        scheduled_transaction_id: BTC_SCH,
        amount: 0.000025,
        splits: [{ amount: 0.000025 }],
      },
      {
        id: "o-usd",
        scheduled_transaction_id: USD_SCH,
        amount: 12.3456,
        splits: [{ amount: 12.3456 }],
      },
    ],
  });

  const byId = (rows: Record<string, unknown>[], id: string) =>
    rows.find((row) => row.id === id) as Record<string, unknown>;

  it("scales a fiat amount at four places, byte for byte", () => {
    const out = obfuscate(input(), 1.37);
    expect(byId(out.transactions, USD_TX).amount).toBe(16.9135);
    expect(byId(out.accounts, USD_ACC).opening_balance).toBe(16.9135);
    expect(byId(out.scheduled_transactions, USD_SCH).amount).toBe(16.9135);
    expect(byId(out.scheduled_transaction_overrides, "o-usd").amount).toBe(
      16.9135,
    );
  });

  it("scales a coin amount at the coin's own places", () => {
    const out = obfuscate(input(), 1.5);
    expect(byId(out.transactions, BTC_TX).amount).toBe(0.0000375);
    expect(byId(out.accounts, BTC_ACC).opening_balance).toBe(0.0000375);
    expect(byId(out.accounts, BTC_ACC).low_balance_threshold).toBe(0.000018);
    expect(byId(out.scheduled_transactions, BTC_SCH).amount).toBe(0.0000375);
    expect(byId(out.scheduled_transaction_overrides, "o-btc").amount).toBe(
      0.0000375,
    );
    expect(
      (byId(out.scheduled_transaction_overrides, "o-btc").splits as any)[0]
        .amount,
    ).toBe(0.0000375);
  });

  it("scales a split at its parent's account precision", () => {
    const btc = obfuscate(input(), 1.5);
    expect(byId(btc.transaction_splits, "s-btc").amount).toBe(0.0000375);
    expect(byId(btc.scheduled_transaction_splits, "ss-btc").amount).toBe(
      0.0000375,
    );
    const usd = obfuscate(input(), 1.37);
    expect(byId(usd.transaction_splits, "s-usd").amount).toBe(16.9135);
    expect(byId(usd.scheduled_transaction_splits, "ss-usd").amount).toBe(
      16.9135,
    );
  });

  it("scales every other money column at the fiat four places", () => {
    const out = obfuscate(input(), 1.37);
    expect(byId(out.accounts, BTC_ACC).payment_amount).toBe(16.9135);
  });
});
