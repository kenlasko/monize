import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import {
  applyRlsPolicies,
  TEST_APP_ROLE,
  TEST_APP_ROLE_PASSWORD,
} from "../helpers/rls-setup";
import {
  loadEnumFirstValues,
  loadTableCatalog,
  RlsRowSeeder,
  TableCatalog,
} from "../helpers/rls-catalog";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import { rlsExemptTableNames } from "@/common/db/rls-exempt-tables";

/**
 * RLS task T2: the catalog-driven enforcement spec.
 *
 * Every table in the database must land in exactly one of four buckets --
 * a `user_id` column, an explicit owner-column map, an explicit
 * indirect-ownership map, or the explicit exemption list -- and every bucketed
 * table is then exercised under real enforcement (policies + ENABLE + a
 * non-owner role): per-user visibility, fail-closed zero rows, the 22P02
 * garbage-GUC error, WITH CHECK insert rejection, and the bypass GUC. A table
 * this spec has never heard of fails the bucket test the moment it appears,
 * which is the whole point: coverage cannot silently rot as the schema grows.
 *
 * On top of the per-table sweep sit the cases M3's spec does not touch: the
 * `app.preserve_timestamps` trigger behaviour, delegation semantics under both
 * identity GUCs, and the transaction-scoping of the GUCs themselves.
 */
describe("RLS enforcement (T2, catalog-driven)", () => {
  jest.setTimeout(120000);

  let dataSource: DataSource;
  let catalog: TableCatalog;
  let seeder: RlsRowSeeder;

  /**
   * Tables deliberately not policied. The list lives in
   * `backend/src/common/db/rls-exempt-tables.ts` and is checked against the
   * marker block in `database/schema.sql` by a no-database guard, because this
   * spec needs a live PostgreSQL and so never ran in `npm run test:unit` --
   * which is how four hand-maintained copies of this list drifted apart.
   * Rationale per table: `docs/row-level-security-contract.md`.
   */
  const EXEMPT = rlsExemptTableNames();

  /** Bespoke owner columns (the special policies, migration 114). */
  const OWNER_COLUMN_MAP: Record<string, string[]> = {
    users: ["id"],
    account_delegates: ["owner_user_id", "delegate_user_id"],
    delegate_account_favourites: ["delegate_user_id"],
    delegate_net_worth_exclusions: ["delegate_user_id"],
    emergency_access_settings: ["owner_user_id"],
    emergency_access_contacts: ["owner_user_id"],
  };

  /** Tables owned through a parent row (migration 113), child -> owning path. */
  const INDIRECT_MAP: Record<string, string> = {
    transaction_splits: "transactions",
    transaction_tags: "transactions",
    transaction_split_tags: "transaction_splits -> transactions",
    attachment_blobs: "transaction_attachments",
    scheduled_transaction_splits: "scheduled_transactions",
    scheduled_transaction_split_tags:
      "scheduled_transaction_splits -> scheduled_transactions",
    scheduled_transaction_overrides: "scheduled_transactions",
    scheduled_transaction_postings: "scheduled_transactions",
    security_prices: "securities",
    security_tags: "securities",
    holdings: "accounts",
    budget_categories: "budgets",
    budget_periods: "budgets",
    budget_period_categories: "budget_periods -> budgets",
    monte_carlo_cash_flows: "monte_carlo_scenarios",
    account_delegate_grants: "account_delegates",
  };

  const USER_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const USER_B = "bbbbbbbb-2222-4222-8222-222222222222";
  // Delegation fixture: OWNER shares with DELEGATE. Kept away from A/B so the
  // per-table exact-set assertions stay valid alongside these rows.
  const OWNER = "cccccccc-3333-4333-8333-333333333333";
  const DELEGATE = "dddddddd-4444-4444-8444-444444444444";

  /** Every existing non-exempt table -- the set the per-table sweeps cover. */
  let coveredTables: string[] = [];
  let ownerAccounts: { id: string }[] = [];
  let delegationId: string;

  /** Runs `fn` as the unprivileged runtime role with transaction-local GUCs. */
  async function asAppRole<T>(
    gucs: Record<string, string>,
    fn: (m: {
      query: (sql: string, params?: unknown[]) => Promise<any>;
    }) => Promise<T>,
  ): Promise<T> {
    return dataSource.transaction(async (m) => {
      await m.query(`SET LOCAL ROLE ${TEST_APP_ROLE}`);
      for (const [key, value] of Object.entries(gucs)) {
        await m.query("SELECT set_config($1, $2, true)", [key, value]);
      }
      return fn(m);
    });
  }

  /** Both identity GUCs for one user, matching what withUserContext emits. */
  function identity(userId: string): Record<string, string> {
    return { "app.current_user_id": userId, "app.real_user_id": userId };
  }

  function pkKey(table: string, row: Record<string, unknown>): string {
    const pk = catalog.get(table)!.primaryKey;
    if (pk.length === 0) {
      throw new Error(`Table ${table} has no primary key`);
    }
    return JSON.stringify(
      pk.map((c) =>
        row[c] instanceof Date ? (row[c] as Date).toISOString() : row[c],
      ),
    );
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      synchronize: true,
      dropSchema: true,
    } as never);
    await dataSource.initialize();

    // `synchronize` builds from entity metadata, and `schema_migrations` has no
    // entity -- it is the migration runner's own ledger (same gap
    // runtime-role.integration.spec.ts's MT-13 setup closes). Create it before
    // the role is provisioned, so the revoke below the migration-bookkeeping
    // tests exercise is not a silent no-op against a table that does not exist.
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    );

    // Real policies + the M3 enable, applied in filename order (T1's harness).
    await applyRlsPolicies(dataSource, { includeEnable: true });

    catalog = await loadTableCatalog(dataSource);
    seeder = new RlsRowSeeder(
      dataSource,
      catalog,
      await loadEnumFirstValues(dataSource),
    );

    coveredTables = [...catalog.keys()].filter((t) => !EXEMPT.includes(t));

    // Global reference data every seeded row shares.
    await dataSource.query(
      "INSERT INTO currencies (code, name, symbol) VALUES ('USD', 'US Dollar', '$') ON CONFLICT DO NOTHING",
    );

    // One row per covered table for each of the two isolation users.
    await seeder.seedAll(coveredTables, [USER_A, USER_B]);

    // Delegation fixture: OWNER with two accounts, sharing with DELEGATE.
    await seeder.seedRowFor("users", OWNER);
    await seeder.seedRowFor("users", DELEGATE);
    await seeder.seedRowFor("accounts", OWNER);
    const second = seeder.buildInsert("accounts", OWNER);
    await dataSource.query(second.sql, second.values);
    ownerAccounts = await dataSource.query(
      "SELECT id FROM accounts WHERE user_id = $1 ORDER BY created_at",
      [OWNER],
    );

    const delegation = seeder.buildInsert("account_delegates", OWNER, {
      delegate_user_id: DELEGATE,
    });
    const [delegationRow] = await dataSource.query(
      delegation.sql,
      delegation.values,
    );
    delegationId = delegationRow.id;

    const grant = seeder.buildInsert("account_delegate_grants", OWNER, {
      delegation_id: delegationId,
      account_id: ownerAccounts[0].id,
    });
    await dataSource.query(grant.sql, grant.values);

    const favourite = seeder.buildInsert("delegate_account_favourites", OWNER, {
      delegate_user_id: DELEGATE,
      account_id: ownerAccounts[0].id,
    });
    await dataSource.query(favourite.sql, favourite.values);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe("catalog: the four buckets cover the whole schema", () => {
    it("places every table in exactly one bucket", () => {
      const violations: string[] = [];
      for (const [table, entry] of catalog) {
        const memberships = [
          EXEMPT.includes(table),
          table in OWNER_COLUMN_MAP,
          table in INDIRECT_MAP,
          entry.columns.some((c) => c.name === "user_id"),
        ].filter(Boolean).length;
        if (memberships !== 1) {
          violations.push(
            `${table}: in ${memberships} buckets (a new table must get a ` +
              "user_id column, an owner/indirect map entry, or an explicit exemption)",
          );
        }
      }
      expect(violations).toEqual([]);
    });

    it("has a policy and RLS enabled on every covered table, neither on exempt ones", async () => {
      const policied = new Set<string>(
        (
          await dataSource.query(
            "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'",
          )
        ).map((r: { tablename: string }) => r.tablename),
      );
      const enabled = new Set<string>(
        (
          await dataSource.query(
            `SELECT c.relname FROM pg_class c
               JOIN pg_namespace ns ON ns.oid = c.relnamespace
              WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`,
          )
        ).map((r: { relname: string }) => r.relname),
      );

      const violations: string[] = [];
      for (const table of coveredTables) {
        if (!policied.has(table)) violations.push(`${table}: no policy`);
        if (!enabled.has(table)) violations.push(`${table}: RLS not enabled`);
      }
      for (const table of EXEMPT.filter((t) => catalog.has(t))) {
        if (policied.has(table))
          violations.push(`${table}: exempt but policied`);
        if (enabled.has(table)) violations.push(`${table}: exempt but enabled`);
      }
      expect(violations).toEqual([]);
    });
  });

  describe("per-table enforcement as the runtime role", () => {
    it("shows each user exactly their own seeded rows", async () => {
      const violations: string[] = [];
      for (const table of coveredTables) {
        for (const user of [USER_A, USER_B]) {
          const visible = await asAppRole(identity(user), (m) =>
            m.query(`SELECT * FROM "${table}"`),
          );
          const got = visible
            .map((r: Record<string, unknown>) => pkKey(table, r))
            .sort();
          const want = [pkKey(table, seeder.seededRowFor(table, user))];
          if (JSON.stringify(got) !== JSON.stringify(want)) {
            violations.push(
              `${table} (user ${user === USER_A ? "A" : "B"}): saw ${got.length} ` +
                `row(s), expected exactly the 1 seeded row`,
            );
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it("returns zero rows with the identity GUCs unset or empty", async () => {
      const violations: string[] = [];
      for (const table of coveredTables) {
        const unset = await asAppRole({}, (m) =>
          m.query(`SELECT count(*)::int AS n FROM "${table}"`),
        );
        if (unset[0].n !== 0) {
          violations.push(`${table}: ${unset[0].n} rows with no GUC`);
        }
        const empty = await asAppRole(
          { "app.current_user_id": "", "app.real_user_id": "" },
          (m) => m.query(`SELECT count(*)::int AS n FROM "${table}"`),
        );
        if (empty[0].n !== 0) {
          violations.push(`${table}: ${empty[0].n} rows with empty-string GUC`);
        }
      }
      expect(violations).toEqual([]);
    });

    it("raises 22P02 -- not empty results -- on a non-UUID identity GUC", async () => {
      const violations: string[] = [];
      for (const table of coveredTables) {
        try {
          await asAppRole(
            { "app.current_user_id": "garbage", "app.real_user_id": "garbage" },
            (m) => m.query(`SELECT count(*) FROM "${table}"`),
          );
          violations.push(`${table}: statement succeeded`);
        } catch (err) {
          if (
            !/invalid input syntax for type uuid/i.test((err as Error).message)
          ) {
            violations.push(`${table}: wrong error: ${(err as Error).message}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it("rejects a cross-user INSERT via WITH CHECK on every covered table", async () => {
      const violations: string[] = [];
      for (const table of coveredTables) {
        // A fresh row owned by B (or, for users, by a brand-new id), inserted
        // while the GUCs name A. For direct and special tables the owner column
        // itself fails the check; for indirect tables the EXISTS cannot see B's
        // parent row under A's GUC.
        const owner = table === "users" ? randomUUID() : USER_B;
        const { sql, values } = seeder.buildInsert(table, owner);
        try {
          await asAppRole(identity(USER_A), (m) => m.query(sql, values));
          violations.push(`${table}: cross-user insert succeeded`);
        } catch (err) {
          if (!/row-level security/i.test((err as Error).message)) {
            violations.push(`${table}: wrong error: ${(err as Error).message}`);
          }
        }
      }
      expect(violations).toEqual([]);
    });

    it("sees every row under the bypass GUC", async () => {
      const violations: string[] = [];
      for (const table of coveredTables) {
        const [{ n: total }] = await dataSource.query(
          `SELECT count(*)::int AS n FROM "${table}"`,
        );
        const bypass = await asAppRole({ "app.bypass_rls": "on" }, (m) =>
          m.query(`SELECT count(*)::int AS n FROM "${table}"`),
        );
        if (bypass[0].n !== total) {
          violations.push(`${table}: bypass saw ${bypass[0].n} of ${total}`);
        }
      }
      expect(violations).toEqual([]);
    });
  });

  describe("app.preserve_timestamps trigger behaviour", () => {
    it("has the updated_at trigger attached to accounts (guards against a vacuous pass)", async () => {
      const rows = await dataSource.query(
        `SELECT tgname FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE c.relname = 'accounts' AND p.proname = 'update_updated_at_column'
            AND NOT t.tgisinternal`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it("stamps updated_at on an ordinary UPDATE and preserves it under the GUC", async () => {
      const account = seeder.seededRowFor("accounts", USER_A);
      const supplied = "2020-01-02 03:04:05";

      // TypeORM returns [records, affectedCount] for a raw UPDATE.
      const [[stamped]] = await dataSource.query(
        `UPDATE accounts SET updated_at = $1 WHERE id = $2
         RETURNING to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS ts,
                   (updated_at > now() - interval '1 minute') AS fresh`,
        [supplied, account.id],
      );
      expect(stamped.ts).not.toBe(supplied);
      expect(stamped.fresh).toBe(true);

      const preserved = await dataSource.transaction(async (m) => {
        await m.query(
          "SELECT set_config('app.preserve_timestamps', 'on', true)",
        );
        const [rows] = await m.query(
          `UPDATE accounts SET updated_at = $1 WHERE id = $2
           RETURNING to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS ts`,
          [supplied, account.id],
        );
        return rows[0];
      });
      expect(preserved.ts).toBe(supplied);
    });

    it("preserves timestamps for the runtime role under enforcement too", async () => {
      const account = seeder.seededRowFor("accounts", USER_A);
      const supplied = "2021-05-06 07:08:09";
      const row = await asAppRole(
        { ...identity(USER_A), "app.preserve_timestamps": "on" },
        async (m) => {
          const [rows] = await m.query(
            `UPDATE accounts SET updated_at = $1 WHERE id = $2
             RETURNING to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS ts`,
            [supplied, account.id],
          );
          return rows[0];
        },
      );
      expect(row.ts).toBe(supplied);
    });
  });

  describe("delegation semantics -- current = owner, real = delegate", () => {
    const acting = {
      "app.current_user_id": OWNER,
      "app.real_user_id": DELEGATE,
    };

    it("shows the acting delegate the owner's accounts", async () => {
      const rows = await asAppRole(acting, (m) =>
        m.query("SELECT id FROM accounts ORDER BY created_at"),
      );
      expect(rows.map((r: { id: string }) => r.id)).toEqual(
        ownerAccounts.map((a) => a.id),
      );
    });

    it("shows the acting delegate both users rows -- the real arm on users", async () => {
      const rows = await asAppRole(acting, (m) =>
        m.query("SELECT id FROM users ORDER BY id"),
      );
      expect(rows.map((r: { id: string }) => r.id).sort()).toEqual(
        [OWNER, DELEGATE].sort(),
      );
    });

    it("shows the delegation row from both sides", async () => {
      for (const gucs of [
        acting,
        identity(DELEGATE), // own session: only the delegate_user_id arm matches
        identity(OWNER), // owner managing their sharing
      ]) {
        const rows = await asAppRole(gucs, (m) =>
          m.query("SELECT id FROM account_delegates WHERE id = $1", [
            delegationId,
          ]),
        );
        expect(rows).toHaveLength(1);
      }
    });

    it("shows the grant rows through the parent's real arm in the delegate's own session", async () => {
      const rows = await asAppRole(identity(DELEGATE), (m) =>
        m.query(
          "SELECT id FROM account_delegate_grants WHERE delegation_id = $1",
          [delegationId],
        ),
      );
      expect(rows).toHaveLength(1);
    });

    it("lets the acting delegate read and insert their own favourites", async () => {
      const visible = await asAppRole(acting, (m) =>
        m.query(
          "SELECT account_id FROM delegate_account_favourites WHERE delegate_user_id = $1",
          [DELEGATE],
        ),
      );
      expect(visible.map((r: { account_id: string }) => r.account_id)).toEqual([
        ownerAccounts[0].id,
      ]);

      const insert = seeder.buildInsert("delegate_account_favourites", OWNER, {
        delegate_user_id: DELEGATE,
        account_id: ownerAccounts[1].id,
      });
      await asAppRole(acting, (m) => m.query(insert.sql, insert.values));

      const after = await asAppRole(acting, (m) =>
        m.query(
          "SELECT count(*)::int AS n FROM delegate_account_favourites WHERE delegate_user_id = $1",
          [DELEGATE],
        ),
      );
      expect(after[0].n).toBe(2);
    });

    it("hides the delegate's favourites from the owner alone", async () => {
      const rows = await asAppRole(identity(OWNER), (m) =>
        m.query(
          "SELECT count(*)::int AS n FROM delegate_account_favourites WHERE delegate_user_id = $1",
          [DELEGATE],
        ),
      );
      expect(rows[0].n).toBe(0);
    });

    it("shows the delegate's own session exactly the granted account -- the 134 arm", async () => {
      // Before migration 134 this asserted zero rows; the joint-account read
      // arm deliberately widens it to the can_read-granted account, and only
      // that one. The ungranted second account stays hidden.
      const rows = await asAppRole(identity(DELEGATE), (m) =>
        m.query("SELECT id FROM accounts"),
      );
      expect(rows.map((r: { id: string }) => r.id)).toEqual([
        ownerAccounts[0].id,
      ]);
    });

    describe("delegate READ arm on transactions (migration 132)", () => {
      let grantedTxId: string;
      let ungrantedTxId: string;

      beforeAll(async () => {
        // One transaction in the granted account, one in the ungranted one.
        const granted = seeder.buildInsert("transactions", OWNER, {
          account_id: ownerAccounts[0].id,
        });
        const [g] = await dataSource.query(granted.sql, granted.values);
        grantedTxId = g.id;
        const ungranted = seeder.buildInsert("transactions", OWNER, {
          account_id: ownerAccounts[1].id,
        });
        const [u] = await dataSource.query(ungranted.sql, ungranted.values);
        ungrantedTxId = u.id;
      });

      it("exposes the granted account's transactions to the delegate's own session", async () => {
        const rows = await asAppRole(identity(DELEGATE), (m) =>
          m.query("SELECT id FROM transactions"),
        );
        expect(rows.map((r: { id: string }) => r.id)).toEqual([grantedTxId]);
      });

      it("keeps the ungranted account's transactions hidden from the delegate", async () => {
        const rows = await asAppRole(identity(DELEGATE), (m) =>
          m.query("SELECT count(*)::int AS n FROM transactions WHERE id = $1", [
            ungrantedTxId,
          ]),
        );
        expect(rows[0].n).toBe(0);
      });

      it("hides everything again when the delegation is revoked", async () => {
        await dataSource.query(
          "UPDATE account_delegates SET status = 'revoked' WHERE id = $1",
          [delegationId],
        );
        try {
          const rows = await asAppRole(identity(DELEGATE), (m) =>
            m.query("SELECT count(*)::int AS n FROM transactions"),
          );
          expect(rows[0].n).toBe(0);
        } finally {
          await dataSource.query(
            "UPDATE account_delegates SET status = 'active' WHERE id = $1",
            [delegationId],
          );
        }
      });

      it("keeps WITH CHECK owner-only: the read grant does not allow inserts", async () => {
        const insert = seeder.buildInsert("transactions", OWNER, {
          account_id: ownerAccounts[0].id,
        });
        await expect(
          asAppRole(identity(DELEGATE), (m) =>
            m.query(insert.sql, insert.values),
          ),
        ).rejects.toThrow(/row-level security/i);
      });
    });

    describe("delegate READ arms for joint native reads (migration 134)", () => {
      let grantedSplitTxId: string;
      let ungrantedSplitTxId: string;
      let ownerTagId: string;

      beforeAll(async () => {
        // Balance snapshots for both owner accounts.
        for (const account of ownerAccounts) {
          const mab = seeder.buildInsert("monthly_account_balances", OWNER, {
            account_id: account.id,
          });
          await dataSource.query(mab.sql, mab.values);
        }

        // A transaction with a split and a tag in each account.
        const ownerTag = seeder.buildInsert("tags", OWNER);
        const [tagRow] = await dataSource.query(ownerTag.sql, ownerTag.values);
        ownerTagId = tagRow.id;

        for (const [i, account] of ownerAccounts.entries()) {
          const tx = seeder.buildInsert("transactions", OWNER, {
            account_id: account.id,
          });
          const [txRow] = await dataSource.query(tx.sql, tx.values);
          if (i === 0) grantedSplitTxId = txRow.id;
          else ungrantedSplitTxId = txRow.id;

          const split = seeder.buildInsert("transaction_splits", OWNER, {
            transaction_id: txRow.id,
          });
          await dataSource.query(split.sql, split.values);
          const txTag = seeder.buildInsert("transaction_tags", OWNER, {
            transaction_id: txRow.id,
            tag_id: ownerTagId,
          });
          await dataSource.query(txTag.sql, txTag.values);
        }

        // Reference data owned by OWNER (categories/payees seeded here; the
        // tag above already exists).
        for (const table of ["categories", "payees"]) {
          const row = seeder.buildInsert(table, OWNER);
          await dataSource.query(row.sql, row.values);
        }
      });

      it("exposes the granted account's balance snapshots to the delegate's own session", async () => {
        const rows = await asAppRole(identity(DELEGATE), (m) =>
          m.query("SELECT account_id FROM monthly_account_balances"),
        );
        expect(rows.map((r: { account_id: string }) => r.account_id)).toEqual([
          ownerAccounts[0].id,
        ]);
      });

      it("exposes splits and tag links only through the granted account", async () => {
        const splits = await asAppRole(identity(DELEGATE), (m) =>
          m.query("SELECT transaction_id FROM transaction_splits"),
        );
        expect(
          splits.map((r: { transaction_id: string }) => r.transaction_id),
        ).toEqual([grantedSplitTxId]);

        const tagLinks = await asAppRole(identity(DELEGATE), (m) =>
          m.query("SELECT transaction_id FROM transaction_tags"),
        );
        expect(
          tagLinks.map((r: { transaction_id: string }) => r.transaction_id),
        ).toEqual([grantedSplitTxId]);
        void ungrantedSplitTxId;
      });

      it("exposes the owner's reference data to the delegate's own session", async () => {
        for (const table of ["categories", "payees", "tags"]) {
          const rows = await asAppRole(identity(DELEGATE), (m) =>
            m.query(
              `SELECT count(*)::int AS n FROM "${table}" WHERE user_id = $1`,
              [OWNER],
            ),
          );
          expect({ table, n: rows[0].n }).toEqual({
            table,
            n: 1,
          });
        }
      });

      it("keeps the owner's reference data hidden from unrelated users", async () => {
        for (const table of ["categories", "payees", "tags"]) {
          const rows = await asAppRole(identity(USER_A), (m) =>
            m.query(
              `SELECT count(*)::int AS n FROM "${table}" WHERE user_id = $1`,
              [OWNER],
            ),
          );
          expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
        }
      });

      it("hides everything again when the delegation is revoked", async () => {
        await dataSource.query(
          "UPDATE account_delegates SET status = 'revoked' WHERE id = $1",
          [delegationId],
        );
        try {
          for (const [table, sql] of [
            ["accounts", "SELECT count(*)::int AS n FROM accounts"],
            [
              "monthly_account_balances",
              "SELECT count(*)::int AS n FROM monthly_account_balances",
            ],
            [
              "transaction_splits",
              "SELECT count(*)::int AS n FROM transaction_splits",
            ],
            [
              "categories",
              `SELECT count(*)::int AS n FROM categories WHERE user_id = '${OWNER}'`,
            ],
          ] as const) {
            const rows = await asAppRole(identity(DELEGATE), (m) =>
              m.query(sql),
            );
            expect({ table, n: rows[0].n }).toEqual({ table, n: 0 });
          }
        } finally {
          await dataSource.query(
            "UPDATE account_delegates SET status = 'active' WHERE id = $1",
            [delegationId],
          );
        }
      });

      it("keeps WITH CHECK owner-only on the widened tables", async () => {
        const account = seeder.buildInsert("accounts", OWNER);
        await expect(
          asAppRole(identity(DELEGATE), (m) =>
            m.query(account.sql, account.values),
          ),
        ).rejects.toThrow(/row-level security/i);

        const mab = seeder.buildInsert("monthly_account_balances", OWNER, {
          account_id: ownerAccounts[0].id,
        });
        await expect(
          asAppRole(identity(DELEGATE), (m) => m.query(mab.sql, mab.values)),
        ).rejects.toThrow(/row-level security/i);
      });
    });
  });

  describe("GUC scope -- withScopedDb's identity dies with its transaction", () => {
    it("clears both GUCs at commit; a later statement on the same connection sees zero rows", async () => {
      // A single-connection pool as the runtime role, so the post-commit
      // statements provably reuse the very connection withScopedDb ran on.
      const appDataSource = new DataSource({
        ...INTEGRATION_TYPEORM_OPTIONS,
        username: TEST_APP_ROLE,
        password: TEST_APP_ROLE_PASSWORD,
        synchronize: false,
        dropSchema: false,
        extra: { max: 1 },
      } as never);
      await appDataSource.initialize();
      const previousMode = process.env.RLS_MODE;
      process.env.RLS_MODE = "enforce";
      try {
        const names = await withUserContext(USER_A, () =>
          withScopedDb(appDataSource, async (m) => {
            const [setting] = await m.query(
              "SELECT current_setting('app.current_user_id', true) AS v",
            );
            expect(setting.v).toBe(USER_A);
            return m.query("SELECT name FROM accounts");
          }),
        );
        expect(names).toHaveLength(1);
        expect(names[0].name).toBe(
          seeder.seededRowFor("accounts", USER_A).name,
        );

        const [{ v }] = await appDataSource.query(
          "SELECT current_setting('app.current_user_id', true) AS v",
        );
        expect(v === null || v === "").toBe(true);
        const [{ r }] = await appDataSource.query(
          "SELECT current_setting('app.real_user_id', true) AS r",
        );
        expect(r === null || r === "").toBe(true);

        const [{ n }] = await appDataSource.query(
          "SELECT count(*)::int AS n FROM accounts",
        );
        expect(n).toBe(0);
      } finally {
        if (previousMode === undefined) {
          delete process.env.RLS_MODE;
        } else {
          process.env.RLS_MODE = previousMode;
        }
        await appDataSource.destroy();
      }
    });
  });

  /**
   * `currencies` is exempt reference data, but `user_currency_preferences` is
   * not -- and its FK to `currencies(code)` is `ON DELETE CASCADE`. So a
   * decision to delete a shared currency row, taken from inside one tenant's
   * transaction, deletes rows that tenant cannot see.
   *
   * That is what happened: `CurrenciesService.remove` counted the remaining
   * preference rows for the code with a tenant-scoped query, got zero because
   * RLS had filtered away the other user's row, and deleted the currency --
   * cascading that user's activation away. The restore's cleanup had the same
   * blindness in a different shape.
   *
   * Only enforcement can demonstrate this, which is why it lives here: under
   * `RLS_MODE=off` the app connects as the owner and every query sees
   * everything, so the old code looked correct in every unit test.
   */
  describe("currency liveness is global, not tenant-scoped", () => {
    const CODE = "PTS";

    it("sees another user's activation that a tenant-scoped count cannot", async () => {
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ($1, 'Family Points', '*', 0, true, $2)
         ON CONFLICT (code) DO NOTHING`,
        [CODE, USER_A],
      );
      // Only user B activates it. A has no preference row for the code at all,
      // which is exactly the state `remove` reaches after deleting its own.
      await dataSource.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO NOTHING`,
        [USER_B, CODE],
      );

      const appDataSource = new DataSource({
        ...INTEGRATION_TYPEORM_OPTIONS,
        username: TEST_APP_ROLE,
        password: TEST_APP_ROLE_PASSWORD,
        synchronize: false,
        dropSchema: false,
        extra: { max: 1 },
      } as never);
      await appDataSource.initialize();
      const previousMode = process.env.RLS_MODE;
      process.env.RLS_MODE = "enforce";
      try {
        const { tenantView, globalAnswer } = await withUserContext(USER_A, () =>
          withScopedDb(appDataSource, async (m) => {
            const [counted] = await m.query(
              `SELECT count(*)::int AS n FROM user_currency_preferences
                  WHERE currency_code = $1`,
              [CODE],
            );
            const [answer] = await m.query(
              `SELECT currency_code_in_use_globally($1) AS "inUse"`,
              [CODE],
            );
            return { tenantView: counted.n, globalAnswer: answer.inUse };
          }),
        );

        // The query the old code trusted: B's row is invisible, so it says the
        // code is unused and the delete looks safe.
        expect(tenantView).toBe(0);
        // The SECURITY DEFINER function, in the same transaction as that query,
        // gives the answer the delete actually needs.
        expect(globalAnswer).toBe(true);
      } finally {
        if (previousMode === undefined) {
          delete process.env.RLS_MODE;
        } else {
          process.env.RLS_MODE = previousMode;
        }
        await appDataSource.destroy();
      }
    });

    it("reports an unreferenced code as free", async () => {
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ('ZZZ', 'Nothing Points', '?', 0, true, $1)
         ON CONFLICT (code) DO NOTHING`,
        [USER_A],
      );
      // "Unknown" is not the answer here: nothing references the code, which is
      // a settled fact, and reporting it as live would strand the row forever.
      const [{ inUse }] = await dataSource.query(
        `SELECT currency_code_in_use_globally('ZZZ') AS "inUse"`,
      );
      expect(inUse).toBe(false);
    });

    /**
     * The race the definer function alone does not close (F3R-005).
     *
     * Deleting a currency is: check whether anybody still references the code,
     * then delete the row. `user_currency_preferences.currency_code` cascades on
     * delete, so a preference another user inserts and commits between those two
     * steps is removed by the cascade -- they get a success response and
     * immediately lose the setting.
     *
     * `SELECT ... FOR UPDATE` on the parent is what serialises it, through the FK
     * machinery rather than around it: an FK check takes `FOR KEY SHARE` on the
     * parent row, which conflicts. So the concurrent insert waits, and once the
     * deleting transaction commits, the insert fails with a plain FK violation.
     *
     * Two real connections, because one cannot demonstrate a lock.
     */
    it("makes a concurrent activation wait for the delete, then fail cleanly", async () => {
      const CODE = "RCE";
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ($1, 'Race Points', 'R', 0, true, $2)
         ON CONFLICT (code) DO NOTHING`,
        [CODE, USER_A],
      );

      const other = new DataSource({
        ...INTEGRATION_TYPEORM_OPTIONS,
        synchronize: false,
        dropSchema: false,
        extra: { max: 1 },
      } as never);
      await other.initialize();

      try {
        let activationSettled = false;
        let activationError: unknown;
        // Populated inside the transaction below; declared here so the
        // deleter's callback does not have to return it. Returning a promise
        // from a TypeORM transaction callback is implicitly awaited before
        // the transaction commits -- and this promise cannot settle until
        // that same commit releases the lock B is waiting on. Awaiting it
        // from inside the transaction is therefore a guaranteed deadlock, not
        // a race: A waits on B, B waits on A's commit, and nothing ever
        // completes. It is awaited instead after `deleter` resolves, below.
        let activation!: Promise<void>;

        // A: hold the lock the delete path takes, with nothing else in flight.
        const deleter = dataSource.transaction(async (m) => {
          await m.query("SELECT 1 FROM currencies WHERE code = $1 FOR UPDATE", [
            CODE,
          ]);

          // B: activate the same code. Its FK check needs FOR KEY SHARE on the
          // locked parent, so it must block rather than commit.
          activation = other
            .transaction(async (n) =>
              n.query(
                `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
                 VALUES ($1, $2, true)`,
                [USER_B, CODE],
              ),
            )
            .then(
              () => {
                activationSettled = true;
              },
              (error) => {
                activationSettled = true;
                activationError = error;
              },
            );

          // Give it real time to prove it is waiting rather than merely slow.
          await new Promise((resolve) => setTimeout(resolve, 400));
          expect(activationSettled).toBe(false);

          await m.query("DELETE FROM currencies WHERE code = $1", [CODE]);
        });

        await deleter;
        // The commit just released the lock; B's blocked insert can now settle
        // one way or the other. `activation`'s own .then never rejects, so this
        // cannot throw -- it only waits.
        await activation;

        // The forbidden outcome is a committed preference the cascade removed.
        // Either B failed, or B holds a preference for a currency that still
        // exists -- never a success that left nothing behind.
        expect(activationSettled).toBe(true);
        const surviving = await dataSource.query(
          "SELECT 1 FROM user_currency_preferences WHERE user_id = $1 AND currency_code = $2",
          [USER_B, CODE],
        );
        if (activationError === undefined) {
          expect(surviving).toHaveLength(1);
        } else {
          expect(surviving).toHaveLength(0);
        }
        // And the code really is gone, so the delete was not what lost.
        const currency = await dataSource.query(
          "SELECT 1 FROM currencies WHERE code = $1",
          [CODE],
        );
        expect(currency).toHaveLength(0);
      } finally {
        await other.destroy();
        await dataSource.query(
          "DELETE FROM user_currency_preferences WHERE currency_code = $1",
          [CODE],
        );
        await dataSource.query("DELETE FROM currencies WHERE code = $1", [
          CODE,
        ]);
      }
    });

    /**
     * The per-user companion, which the delete gate asks before removing the
     * caller's activation row. `CurrenciesService.isInUse` used to spell the
     * referencing columns out itself and was missing `budgets.currency_code`, so
     * a user with a budget denominated in a custom currency was told the code was
     * not in use, lost their activation row, and was left with a budget in a
     * currency that no longer appeared anywhere in their settings.
     *
     * A unit spec cannot show this -- it mocks `manager.query` and gets back
     * whatever the fixture says. Only the real function over real rows can.
     */
    it("counts a budget as a reference to the currency it is denominated in", async () => {
      const CODE = "BGT";
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ($1, 'Budget Points', 'B', 0, true, $2)
         ON CONFLICT (code) DO NOTHING`,
        [CODE, USER_A],
      );
      await dataSource.query(
        `INSERT INTO budgets (user_id, name, period_start, currency_code)
         VALUES ($1, 'Points budget', DATE '2026-01-01', $2)`,
        [USER_A, CODE],
      );

      const referenced: Array<{ code: string }> = await dataSource.query(
        `SELECT code FROM currency_codes_referenced_by_user_data($1) AS referenced(code)`,
        [USER_A],
      );
      expect(referenced.map((r) => r.code)).toContain(CODE);

      // And the other user's answer must not include it, or a shared code would
      // become undeletable for everyone.
      const otherUser: Array<{ code: string }> = await dataSource.query(
        `SELECT code FROM currency_codes_referenced_by_user_data($1) AS referenced(code)`,
        [USER_B],
      );
      expect(otherUser.map((r) => r.code)).not.toContain(CODE);
    });

    /**
     * The two per-user functions differ by exactly one branch, and the difference
     * is load-bearing in both directions: the backup export needs the activation
     * row counted so an activated-but-unspent currency definition travels with
     * the file, and the delete gate needs it *not* counted or no currency could
     * ever be deleted.
     */
    it("counts an activation only in the composite, not in the data answer", async () => {
      const CODE = "ACT";
      await dataSource.query(
        `INSERT INTO currencies (code, name, symbol, decimal_places, is_active, created_by_user_id)
         VALUES ($1, 'Activated Points', 'A', 0, true, $2)
         ON CONFLICT (code) DO NOTHING`,
        [CODE, USER_A],
      );
      // Activated and nothing else: no account, no budget, no transaction.
      await dataSource.query(
        `INSERT INTO user_currency_preferences (user_id, currency_code, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (user_id, currency_code) DO NOTHING`,
        [USER_A, CODE],
      );

      const data: Array<{ code: string }> = await dataSource.query(
        `SELECT code FROM currency_codes_referenced_by_user_data($1) AS referenced(code)`,
        [USER_A],
      );
      const all: Array<{ code: string }> = await dataSource.query(
        `SELECT code FROM currency_codes_referenced_by_user($1) AS referenced(code)`,
        [USER_A],
      );

      expect(data.map((r) => r.code)).not.toContain(CODE);
      expect(all.map((r) => r.code)).toContain(CODE);
    });
  });

  describe("runtime role privileges on migration bookkeeping", () => {
    it("cannot write schema_migrations", async () => {
      // The blanket table grant includes it. Inserting a filename makes the next
      // deployment skip required DDL; deleting one makes a migration body re-run.
      await expect(
        asAppRole(identity(USER_A), (m) =>
          m.query(
            "INSERT INTO schema_migrations (filename) VALUES ('999_hostile.sql')",
          ),
        ),
      ).rejects.toThrow(/permission denied/i);

      await expect(
        asAppRole(identity(USER_A), (m) =>
          m.query("DELETE FROM schema_migrations"),
        ),
      ).rejects.toThrow(/permission denied/i);
    });

    // Reading the ledger is intentionally left granted -- asserted against the
    // running role in MT-13
    // (runtime-role.integration.spec.ts: "may read the migration ledger but not
    // write it"), which asserts SELECT succeeds. An earlier version of this
    // test asserted the opposite (SELECT denied too) and contradicted that
    // already-reviewed design; removed rather than fixed to keep the one
    // authoritative assertion of this grant surface in MT-13's file instead of
    // two specs quietly disagreeing about it.

    it("still has DML on an ordinary user table", async () => {
      // The revoke has to be surgical: revoking too much would break the app.
      const rows = await asAppRole(identity(USER_A), (m) =>
        m.query("SELECT count(*)::int AS n FROM accounts"),
      );
      expect(rows[0].n).toBeGreaterThanOrEqual(0);
    });
  });
});
