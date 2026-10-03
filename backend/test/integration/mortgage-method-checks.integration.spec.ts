import { DataSource } from "typeorm";
import * as fs from "fs";
import * as path from "path";

import {
  INTEGRATION_TYPEORM_OPTIONS,
  cleanTables,
  createTestUserDirect,
} from "../helpers/integration-setup";

/**
 * The two CHECKs the LINEAR and INTEREST_ONLY methods ship with
 * (docs/specs/mortgage-types.md, decisions 10 and 11): `prepayment_mode` is
 * null on every type but LINEAR, and `payment_amount` is null on LINEAR and
 * INTEREST_ONLY, so a writer that was missed fails at the constraint instead
 * of storing a figure no method uses. The harness builds its schema from the
 * entities, which carry no CHECK, so the migrations are read from disk and
 * applied here, as production applies them.
 */
describe("mortgage method CHECKs (integration)", () => {
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

  const insertMortgage = (
    id: string,
    fields: {
      mortgageType: string;
      prepaymentMode?: string | null;
      paymentAmount?: number | null;
    },
  ) =>
    dataSource.query(
      `INSERT INTO accounts (id, user_id, account_type, name, currency_code,
                             opening_balance, current_balance, mortgage_type,
                             prepayment_mode, payment_amount)
       VALUES ($1, $2, 'MORTGAGE', $3, 'CAD', -300000, -300000, $4, $5, $6)`,
      [
        id,
        owner,
        `Mortgage ${id}`,
        fields.mortgageType,
        fields.prepaymentMode ?? null,
        fields.paymentAmount ?? null,
      ],
    );

  beforeAll(async () => {
    dataSource = new DataSource(INTEGRATION_TYPEORM_OPTIONS as never);
    await dataSource.initialize();
    await cleanTables(dataSource, ["accounts", "users"]);
    // Applied twice: every statement is a no-op on an up-to-date table.
    for (let pass = 0; pass < 2; pass++) {
      await dataSource.query(migration("accounts_prepayment_mode"));
      await dataSource.query(migration("accounts_payment_amount_method_check"));
    }
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      // Leave the shared schema as the entities map it.
      await cleanTables(dataSource, ["accounts", "users"]);
      for (const constraint of [
        "accounts_prepayment_mode_check",
        "accounts_prepayment_mode_linear_only",
        "accounts_payment_amount_method_check",
      ]) {
        await dataSource.query(
          `ALTER TABLE accounts DROP CONSTRAINT IF EXISTS ${constraint}`,
        );
      }
      await dataSource.destroy();
    }
  });

  beforeEach(async () => {
    await cleanTables(dataSource, ["accounts", "users"]);
    owner = (
      await createTestUserDirect(dataSource, {
        email: "mortgage-checks@example.com",
      })
    ).id;
  });

  it("accepts a LINEAR mortgage with a mode and no payment", async () => {
    await insertMortgage("20000000-0000-4000-8000-000000000001", {
      mortgageType: "LINEAR",
      prepaymentMode: "LOWER_INSTALLMENT",
    });
    await insertMortgage("20000000-0000-4000-8000-000000000002", {
      mortgageType: "LINEAR",
      prepaymentMode: null,
    });
    await insertMortgage("20000000-0000-4000-8000-000000000003", {
      mortgageType: "INTEREST_ONLY",
    });
    await insertMortgage("20000000-0000-4000-8000-000000000004", {
      mortgageType: "ANNUITY",
      paymentAmount: 1108.8584,
    });
    // The other annuity type stores its constant payment too. (The column is
    // NOT NULL since the contract migration, so no row has a null type.)
    await insertMortgage("20000000-0000-4000-8000-000000000005", {
      mortgageType: "CANADIAN_FIXED",
      paymentAmount: 1500,
    });
  });

  it.each(["ANNUITY", "CANADIAN_FIXED", "INTEREST_ONLY"])(
    "refuses a prepayment mode on %s",
    async (mortgageType) => {
      await expect(
        insertMortgage("30000000-0000-4000-8000-000000000001", {
          mortgageType,
          prepaymentMode: "SHORTEN_TERM",
        }),
      ).rejects.toThrow(/accounts_prepayment_mode_linear_only/);
    },
  );

  it("refuses a mode the list does not name", async () => {
    await expect(
      insertMortgage("30000000-0000-4000-8000-000000000002", {
        mortgageType: "LINEAR",
        prepaymentMode: "SHORTEN",
      }),
    ).rejects.toThrow(/accounts_prepayment_mode_check/);
  });

  it.each(["LINEAR", "INTEREST_ONLY"])(
    "refuses a stored payment on %s",
    async (mortgageType) => {
      await expect(
        insertMortgage("40000000-0000-4000-8000-000000000001", {
          mortgageType,
          paymentAmount: 1333.3333,
        }),
      ).rejects.toThrow(/accounts_payment_amount_method_check/);
    },
  );

  it("refuses a type change that leaves the payment behind, and takes one that clears it", async () => {
    const id = "50000000-0000-4000-8000-000000000001";
    await insertMortgage(id, {
      mortgageType: "ANNUITY",
      paymentAmount: 1108.86,
    });

    await expect(
      dataSource.query(
        `UPDATE accounts SET mortgage_type = 'LINEAR' WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/accounts_payment_amount_method_check/);

    await dataSource.query(
      `UPDATE accounts
          SET mortgage_type = 'LINEAR', payment_amount = NULL
        WHERE id = $1`,
      [id],
    );
    const [row] = (await dataSource.query(
      `SELECT mortgage_type, payment_amount FROM accounts WHERE id = $1`,
      [id],
    )) as { mortgage_type: string; payment_amount: string | null }[];
    expect(row).toEqual({ mortgage_type: "LINEAR", payment_amount: null });
  });
});
