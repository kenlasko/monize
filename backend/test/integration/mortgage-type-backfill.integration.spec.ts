import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The two `accounts.mortgage_type` migrations against the legacy flag
 * combinations a deployed database holds (docs/specs/mortgage-types.md, table
 * 4.2): the Phase 1 expand migration's backfill, and the contract migration
 * (P3-B1) that re-derives any mortgage still null from the flags, makes the
 * column NOT NULL DEFAULT 'ANNUITY' and drops the flags.
 *
 * A unit test cannot check this, because the claim is about what a SQL `CASE`
 * concludes from production-shaped rows, including the NULL flags the columns
 * permitted; so the fixture is a real database, rebuilt to the pre-Phase-1
 * shape before each case, and the migrations are read from disk.
 */
describe("mortgage_type migrations over the legacy flags", () => {
  let dataSource: DataSource;
  let owner: string;

  const MIGRATIONS_DIR = path.join(__dirname, "../../../database/migrations");
  const migration = (suffix: string): string => {
    const file = fs
      .readdirSync(MIGRATIONS_DIR)
      .find((f) => new RegExp(`^\\d{14}_${suffix}\\.sql$`).test(f));
    if (!file) {
      throw new Error(`No *_${suffix}.sql migration in ${MIGRATIONS_DIR}`);
    }
    return fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
  };
  const applyExpand = () =>
    dataSource.query(migration("accounts_mortgage_type"));
  const applyContract = () =>
    dataSource.query(migration("accounts_mortgage_type_required"));

  /**
   * Rebuild the pre-Phase-1 table: no type column, and the two nullable flags
   * schema.sql carried, so each case starts where a deployed database did.
   */
  const restorePrePhase1 = async () => {
    await dataSource.query(
      `ALTER TABLE accounts
         DROP CONSTRAINT IF EXISTS accounts_mortgage_type_check`,
    );
    await dataSource.query(
      `ALTER TABLE accounts DROP COLUMN IF EXISTS mortgage_type`,
    );
    await dataSource.query(
      `ALTER TABLE accounts
         ADD COLUMN IF NOT EXISTS is_canadian_mortgage BOOLEAN DEFAULT false`,
    );
    await dataSource.query(
      `ALTER TABLE accounts
         ADD COLUMN IF NOT EXISTS is_variable_rate BOOLEAN DEFAULT false`,
    );
  };

  const seedAccount = async (
    id: string,
    fields: {
      accountType?: string;
      isCanadian: boolean | null;
      isVariable: boolean | null;
    },
  ): Promise<void> => {
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             opening_balance, current_balance,
                             is_canadian_mortgage, is_variable_rate)
       VALUES ($1, $2, $3, $4, 'CAD', -300000, -300000, $5, $6)`,
      [
        id,
        owner,
        fields.accountType ?? "MORTGAGE",
        `Account ${id}`,
        fields.isCanadian,
        fields.isVariable,
      ],
    );
  };

  const mortgageType = async (id: string): Promise<string | null> => {
    const [row] = (await dataSource.query(
      `SELECT mortgage_type FROM accounts WHERE id = $1`,
      [id],
    )) as { mortgage_type: string | null }[];
    return row.mortgage_type;
  };

  const accountColumns = async (): Promise<string[]> =>
    (
      (await dataSource.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'accounts'`,
      )) as { column_name: string }[]
    ).map((r) => r.column_name);

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // Leave the shared schema as the entity maps it: the type NOT NULL
      // DEFAULT 'ANNUITY', no flags.
      await cleanTables(dataSource, ["accounts", "users"]);
      await restorePrePhase1();
      await applyExpand();
      await applyContract();
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["accounts", "users"]);
    owner = (
      await createTestUserDirect(dataSource, {
        email: "mortgage-type@example.com",
      })
    ).id;
    await restorePrePhase1();
  });

  it("lands one mortgage per row of table 4.2 on its type", async () => {
    const rows = [
      { id: "10000000-0000-4000-8000-000000000001", c: false, v: false },
      { id: "10000000-0000-4000-8000-000000000002", c: false, v: true },
      { id: "10000000-0000-4000-8000-000000000003", c: true, v: false },
      { id: "10000000-0000-4000-8000-000000000004", c: true, v: true },
    ];
    for (const row of rows) {
      await seedAccount(row.id, { isCanadian: row.c, isVariable: row.v });
    }

    await applyExpand();
    await applyContract();

    expect(await mortgageType(rows[0].id)).toBe("ANNUITY");
    expect(await mortgageType(rows[1].id)).toBe("ANNUITY");
    expect(await mortgageType(rows[2].id)).toBe("CANADIAN_FIXED");
    // Canadian variable computed as a plain annuity: the variable flag
    // cancelled the semi-annual branch, so there is no CANADIAN_VARIABLE type.
    expect(await mortgageType(rows[3].id)).toBe("ANNUITY");
  });

  it("re-derives a mortgage left null at the Phase 1 schema from its flags before dropping them", async () => {
    // A pre-Phase-1 pod serving during the Phase 1 rollout inserted mortgages
    // with the flags and no type; the expand migration had already run, so
    // only the contract migration can still read their flags.
    await applyExpand();
    const fixed = "20000000-0000-4000-8000-000000000001";
    const variable = "20000000-0000-4000-8000-000000000002";
    const plain = "20000000-0000-4000-8000-000000000003";
    await seedAccount(fixed, { isCanadian: true, isVariable: false });
    await seedAccount(variable, { isCanadian: true, isVariable: true });
    await seedAccount(plain, { isCanadian: false, isVariable: false });
    expect(await mortgageType(fixed)).toBeNull();

    await applyContract();

    expect(await mortgageType(fixed)).toBe("CANADIAN_FIXED");
    expect(await mortgageType(variable)).toBe("ANNUITY");
    expect(await mortgageType(plain)).toBe("ANNUITY");
    const columns = await accountColumns();
    expect(columns).not.toContain("is_canadian_mortgage");
    expect(columns).not.toContain("is_variable_rate");
  });

  it("reads a NULL flag as false, as the pre-type periodic rate did", async () => {
    // `isCanadian && !isVariableRate` took the semi-annual branch for
    // (true, null), so that row is CANADIAN_FIXED; a bare
    // `NOT is_variable_rate` would evaluate to NULL and land it on ANNUITY,
    // changing its payment. Checked through both migrations' CASE.
    const canadianNullVariable = "30000000-0000-4000-8000-000000000001";
    const nullCanadian = "30000000-0000-4000-8000-000000000002";
    await seedAccount(canadianNullVariable, {
      isCanadian: true,
      isVariable: null,
    });
    await seedAccount(nullCanadian, { isCanadian: null, isVariable: false });
    await applyExpand();

    const lateCanadianNullVariable = "30000000-0000-4000-8000-000000000003";
    await seedAccount(lateCanadianNullVariable, {
      isCanadian: true,
      isVariable: null,
    });
    await applyContract();

    expect(await mortgageType(canadianNullVariable)).toBe("CANADIAN_FIXED");
    expect(await mortgageType(nullCanadian)).toBe("ANNUITY");
    expect(await mortgageType(lateCanadianNullVariable)).toBe("CANADIAN_FIXED");
  });

  it("gives every non-mortgage account the default, flags or not", async () => {
    const loan = "40000000-0000-4000-8000-000000000001";
    const chequing = "40000000-0000-4000-8000-000000000002";
    await seedAccount(loan, {
      accountType: "LOAN",
      isCanadian: true,
      isVariable: false,
    });
    await seedAccount(chequing, {
      accountType: "CHEQUING",
      isCanadian: false,
      isVariable: false,
    });

    await applyExpand();
    // The expand migration types mortgages only.
    expect(await mortgageType(loan)).toBeNull();
    await applyContract();

    expect(await mortgageType(loan)).toBe("ANNUITY");
    expect(await mortgageType(chequing)).toBe("ANNUITY");
  });

  it("never overwrites a stored type", async () => {
    const id = "50000000-0000-4000-8000-000000000001";
    await seedAccount(id, { isCanadian: true, isVariable: false });
    await applyExpand();
    // A type chosen after Phase 1 outlives the contract, even where it
    // disagrees with the flags.
    await dataSource.query(
      `UPDATE accounts SET mortgage_type = 'LINEAR' WHERE id = $1`,
      [id],
    );

    await applyContract();

    expect(await mortgageType(id)).toBe("LINEAR");
  });

  it("leaves the column NOT NULL DEFAULT 'ANNUITY' under the CHECK", async () => {
    await applyExpand();
    await applyContract();

    const defaulted = "60000000-0000-4000-8000-000000000001";
    await dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             opening_balance, current_balance)
       VALUES ($1, $2, 'CHEQUING', 'Chequing', 'CAD', 0, 0)`,
      [defaulted, owner],
    );
    expect(await mortgageType(defaulted)).toBe("ANNUITY");

    await expect(
      dataSource.query(
        `UPDATE accounts SET mortgage_type = NULL WHERE id = $1`,
        [defaulted],
      ),
    ).rejects.toThrow(/null value/);
    await expect(
      dataSource.query(
        `UPDATE accounts SET mortgage_type = 'CANADIAN_VARIABLE' WHERE id = $1`,
        [defaulted],
      ),
    ).rejects.toThrow(/accounts_mortgage_type_check/);
    for (const type of [
      "ANNUITY",
      "CANADIAN_FIXED",
      "LINEAR",
      "INTEREST_ONLY",
    ]) {
      await dataSource.query(
        `UPDATE accounts SET mortgage_type = $2 WHERE id = $1`,
        [defaulted, type],
      );
      expect(await mortgageType(defaulted)).toBe(type);
    }
  });

  it("re-applies both migrations as no-ops once the flags are gone", async () => {
    // A second apply, and a fresh install replaying every migration on top of
    // a schema.sql that no longer has the flags: neither may name a dropped
    // column outside its existence check.
    const id = "70000000-0000-4000-8000-000000000001";
    await seedAccount(id, { isCanadian: true, isVariable: false });
    await applyExpand();
    await applyContract();

    await applyExpand();
    await applyContract();

    expect(await mortgageType(id)).toBe("CANADIAN_FIXED");
  });
});
