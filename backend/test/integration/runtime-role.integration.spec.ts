import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";

import { INTEGRATION_TYPEORM_OPTIONS } from "../helpers/integration-setup";
import {
  applyRlsPolicies,
  TEST_APP_ROLE,
  TEST_APP_ROLE_PASSWORD,
} from "../helpers/rls-setup";
import { withScopedDb } from "@/common/db/scoped-db";
import { withUserContext } from "@/common/db/with-context";
import {
  FORBIDDEN_ROLE_MEMBERSHIPS,
  KNOWN_SAFE_PREDEFINED_ROLES,
  readRuntimeRoleFacts,
  runtimeRoleViolations,
} from "@/common/db/runtime-role-check";

/**
 * The scenarios two rounds of independent review asked for and neither party
 * could execute: they need a live PostgreSQL and a real non-owner role, so a
 * mocked query double cannot answer them.
 *
 *  - MT-13: does the runtime role's grant surface really refuse a write to
 *    `schema_migrations` while still allowing the read?
 *  - DR-R1: is `pg_has_role(..., 'SET')` really transitive, so a two-hop
 *    membership chain through an unremarkable intermediate role is caught?
 *
 * This matters most for confidence: it is the only way to establish that the
 * startup check's central predicate behaves as the documentation says, rather
 * than as the author read it.
 *
 * The elevation/currency scenarios this file's mixed predecessor also carried
 * (RV-001, FV-003) live in rls-elevation-and-currency.integration.spec.ts.
 */
describe("Runtime role verification (real PostgreSQL)", () => {
  jest.setTimeout(120000);

  let dataSource: DataSource;
  const USER_A = randomUUID();
  const USER_B = randomUUID();
  const previousMode = process.env.RLS_MODE;

  /** A pool of exactly one connection, authenticated as the non-owner role. */
  async function appRolePool(): Promise<DataSource> {
    const ds = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      username: TEST_APP_ROLE,
      password: TEST_APP_ROLE_PASSWORD,
      synchronize: false,
      dropSchema: false,
      extra: { max: 1 },
    } as never);
    await ds.initialize();
    return ds;
  }

  /**
   * Poll a predicate until it holds or the attempts run out. Used where the
   * database reaches a state asynchronously after a client action -- a backend's
   * temporary-slot cleanup on session end races the client-side pool close, so
   * the assertion is "it becomes true", not "it is true this instant".
   */
  async function waitFor(
    predicate: () => Promise<boolean>,
    { attempts = 50, delayMs = 20 } = {},
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      if (await predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    return predicate();
  }

  beforeAll(async () => {
    dataSource = new DataSource({
      ...INTEGRATION_TYPEORM_OPTIONS,
      synchronize: true,
      dropSchema: true,
    } as never);
    await dataSource.initialize();
    // `synchronize` builds from entity metadata, and `schema_migrations` has no
    // entity -- it is the migration runner's own ledger. Create it before the role
    // is provisioned, because the revoke that MT-13 is about is guarded on the
    // table existing and would otherwise be a silent no-op.
    await dataSource.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename VARCHAR(255) PRIMARY KEY,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    await applyRlsPolicies(dataSource, { includeEnable: true });

    // The runtime role is shared and outlives `dropSchema`, so a membership left
    // behind by an aborted run (or by a hand-run query against this database)
    // silently turns every "accepts" case in this file red -- or, worse, could
    // mask a real finding by making a control look already-broken. Start from a
    // known graph and assert it, rather than assuming one.
    const strayMemberships: Array<{ rolname: string }> = await dataSource.query(
      `SELECT g.rolname
         FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [TEST_APP_ROLE],
    );
    for (const { rolname } of strayMemberships) {
      await dataSource.query(`REVOKE ${rolname} FROM ${TEST_APP_ROLE}`);
    }
    const remaining = await dataSource.query(
      `SELECT count(*)::int AS n
         FROM pg_auth_members m
         JOIN pg_roles r ON r.oid = m.member
        WHERE r.rolname = $1`,
      [TEST_APP_ROLE],
    );
    expect(remaining[0].n).toBe(0);

    await dataSource.query(
      `INSERT INTO currencies (code, name, symbol, decimal_places, is_active)
       VALUES ('USD', 'US Dollar', '$', 2, true)
       ON CONFLICT (code) DO NOTHING`,
    );
    for (const id of [USER_A, USER_B]) {
      await dataSource.query(
        `INSERT INTO users (id, email, password_hash, first_name, last_name)
         VALUES ($1, $2, 'x', 'T', 'U')`,
        [id, `${id}@example.test`],
      );
      await dataSource.query(
        `INSERT INTO accounts (id, user_id, name, account_type, currency_code)
         VALUES ($1, $2, $3, 'CHEQUING', 'USD')`,
        [randomUUID(), id, `acct-${id.slice(0, 8)}`],
      );
    }
  });

  afterAll(async () => {
    if (previousMode === undefined) delete process.env.RLS_MODE;
    else process.env.RLS_MODE = previousMode;
    await dataSource?.destroy();
  });

  describe("MT-13 -- the runtime role's grant surface", () => {
    it("may read the migration ledger but not write it", async () => {
      const app = await appRolePool();
      try {
        await expect(
          app.query("SELECT count(*) FROM schema_migrations"),
        ).resolves.toBeDefined();

        await expect(
          app.query(
            "INSERT INTO schema_migrations (filename) VALUES ('999_forged.sql')",
          ),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          app.query("DELETE FROM schema_migrations"),
        ).rejects.toThrow(/permission denied/i);
        await expect(
          app.query("UPDATE schema_migrations SET filename = filename"),
        ).rejects.toThrow(/permission denied/i);
      } finally {
        await app.destroy();
      }
    });

    it("may write an ordinary application table, so the revoke is targeted", async () => {
      // Negative control: a blanket loss of DML would pass the assertions above
      // while breaking every request.
      const app = await appRolePool();
      process.env.RLS_MODE = "enforce";
      try {
        await withUserContext(USER_A, () =>
          withScopedDb(app, (m) =>
            m.query(
              `INSERT INTO accounts (id, user_id, name, account_type, currency_code)
               VALUES ($1, $2, 'writable', 'CHEQUING', 'USD')`,
              [randomUUID(), USER_A],
            ),
          ),
        );
      } finally {
        await dataSource.query("DELETE FROM accounts WHERE name = 'writable'");
        await app.destroy();
      }
    });
  });

  describe("DR-V2 / DR-R1 -- what the startup check sees", () => {
    it("passes the provisioned unprivileged role", async () => {
      const app = await appRolePool();
      try {
        const facts = await readRuntimeRoleFacts(app);
        expect(facts.currentUser).toBe(TEST_APP_ROLE);
        expect(facts.directForbiddenAttributes).toEqual([]);
        expect(facts.ownsDatabase).toBe(false);
        expect(runtimeRoleViolations(facts, TEST_APP_ROLE)).toEqual([]);
      } finally {
        await app.destroy();
      }
    });

    it("refuses the owner connection the rest of the suite uses", async () => {
      // The check has to fail for a real owner, not only for a fabricated fact
      // object. This connection owns the database and every policied table.
      const facts = await readRuntimeRoleFacts(dataSource);
      const violations = runtimeRoleViolations(facts, facts.currentUser);

      expect(violations.length).toBeGreaterThan(0);
      expect(violations.join(" ")).toMatch(/owns this database|SUPERUSER/i);
    });

    it("catches a two-hop SET ROLE chain to the database owner (DR-R1)", async () => {
      // The case a `pg_auth_members.member = r.oid` join cannot see: the runtime
      // role is granted an unremarkable intermediate role, and only that role is
      // granted the owner. This is the whole justification for pg_has_role's
      // transitivity, and a unit test cannot establish it.
      const intermediate = `mid_role_${Date.now()}`;
      const owner = (await dataSource.query("SELECT current_user AS u"))[0].u;
      await dataSource.query(`CREATE ROLE ${intermediate} NOLOGIN`);
      const app = await appRolePool();
      try {
        const before = await readRuntimeRoleFacts(app);
        expect(before.exemptReachableContexts).toEqual([]);

        await dataSource.query(`GRANT ${owner} TO ${intermediate}`);
        await dataSource.query(`GRANT ${intermediate} TO ${TEST_APP_ROLE}`);

        const after = await readRuntimeRoleFacts(app);
        // The OWNER is named, not just the intermediate: reachability, not the
        // first hop.
        expect(after.exemptReachableContexts).toContain(owner);
        const violations = runtimeRoleViolations(after, TEST_APP_ROLE);
        expect(violations.join(" ")).toMatch(/SET ROLE/);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${intermediate} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`REVOKE ${owner} FROM ${intermediate}`);
        await dataSource.query(`DROP ROLE ${intermediate}`);
      }
    });

    /**
     * RR3-001. The membership matrix, measured rather than reasoned about.
     *
     * PostgreSQL 16 stores `INHERIT` and `SET` independently per grant, and they
     * answer different questions:
     *
     *  - `SET` decides whether the role can *become* the other role. Attribute
     *    exemptions (`rolsuper`, `rolbypassrls`) are reachable only this way,
     *    because attributes are not inherited.
     *  - `INHERIT` decides whether the other role's *privileges* are already in
     *    force. Ownership is a privilege, and PostgreSQL's owner check
     *    (`object_ownercheck` -> `has_privs_of_role`) walks inheritable
     *    memberships -- so an inherited owner bypasses RLS immediately, with no
     *    statement to detect.
     *
     * The previous version of this suite asserted that `WITH SET FALSE` was
     * harmless. The row below marked "the defect" is what that actually is.
     */
    const MEMBERSHIP_MATRIX = [
      {
        grant: "WITH INHERIT TRUE, SET FALSE",
        expectRlsActive: false,
        expectVisibleRows: 2,
        expectRejected: true,
        note: "the defect: inherited ownership, no SET ROLE needed",
      },
      {
        grant: "WITH INHERIT FALSE, SET TRUE",
        expectRlsActive: true,
        expectVisibleRows: 1,
        expectRejected: true,
        note: "no bypass yet, but one SET ROLE away",
      },
      {
        grant: "WITH INHERIT FALSE, SET FALSE",
        expectRlsActive: true,
        expectVisibleRows: 1,
        expectRejected: false,
        note: "neither route available: genuinely harmless",
      },
    ] as const;

    it.each(MEMBERSHIP_MATRIX)(
      "owner membership $grant -- $note",
      async ({ grant, expectRlsActive, expectVisibleRows, expectRejected }) => {
        const owner = (await dataSource.query("SELECT current_user AS u"))[0].u;
        const app = await appRolePool();
        try {
          await dataSource.query(`GRANT ${owner} TO ${TEST_APP_ROLE} ${grant}`);

          // What the database itself thinks, as the app role, with a tenant GUC
          // set -- the ground truth the check is supposed to predict.
          const [observed] = await app.query(
            `SELECT row_security_active('accounts') AS rls_active,
                    pg_has_role(current_user, $1, 'SET') AS can_set,
                    pg_has_role(current_user, $1, 'USAGE') AS has_usage`,
            [owner],
          );
          expect(observed.rls_active).toBe(expectRlsActive);

          const visible = await app.transaction(async (m) => {
            await m.query(
              "SELECT set_config('app.current_user_id', $1, true)",
              [USER_A],
            );
            const [{ n }] = await m.query(
              "SELECT count(*)::int AS n FROM accounts",
            );
            return n;
          });
          expect(visible).toBe(expectVisibleRows);

          // And what the startup check concludes. It must agree with the row
          // count: refusing to serve exactly when the boundary is not there.
          const facts = await readRuntimeRoleFacts(app);
          const violations = runtimeRoleViolations(facts, TEST_APP_ROLE);
          if (expectRejected) {
            expect(violations.length).toBeGreaterThan(0);
          } else {
            expect(violations).toEqual([]);
          }

          if (observed.has_usage && !observed.can_set) {
            // The precise shape of the finding: reported through the inherited
            // arm, which `SET` reachability alone could never have seen.
            expect(facts.inheritedOwnerRoles).toContain(owner);
            expect(facts.exemptReachableContexts).not.toContain(owner);
          }
        } finally {
          await app.destroy();
          await dataSource.query(`REVOKE ${owner} FROM ${TEST_APP_ROLE}`);
        }
      },
    );

    it("catches an inherited owner two hops away (RR3-001 + DR-R1)", async () => {
      // Both defects at once: the membership is indirect AND it is inherited
      // rather than SET-reachable. A direct-membership join misses the first, and
      // a SET-only predicate misses the second.
      const owner = (await dataSource.query("SELECT current_user AS u"))[0].u;
      const intermediate = `mid_inherit_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${intermediate} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${owner} TO ${intermediate} WITH INHERIT TRUE, SET FALSE`,
        );
        await dataSource.query(
          `GRANT ${intermediate} TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
        );

        const [observed] = await app.query(
          "SELECT row_security_active('accounts') AS rls_active",
        );
        expect(observed.rls_active).toBe(false);

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedOwnerRoles).toContain(owner);
        expect(runtimeRoleViolations(facts, TEST_APP_ROLE).join(" ")).toContain(
          "inherits the privileges",
        );
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${intermediate} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`REVOKE ${owner} FROM ${intermediate}`);
        await dataSource.query(`DROP ROLE ${intermediate}`);
      }
    });

    /**
     * RR4-001. A chain that changes mode partway: SET to an ordinary bridge, and
     * the bridge inherits the owner.
     *
     * Neither predicate answered this from the runtime role -- SET to the owner is
     * false because the bridge->owner edge is SET FALSE, USAGE to the owner is
     * false because the app->bridge edge is INHERIT FALSE, and the bridge owns
     * nothing in the catalog. Measured before fixing it: rls_active stays true
     * until `SET ROLE bridge`, and then goes false with both tenants' rows
     * visible. So a reachable context has to be judged on what IT can do.
     */
    let bridgeSeq = 0;

    async function withBridge<T>(
      edges: { ownerToBridge: string; bridgeToApp: string },
      fn: (bridge: string) => Promise<T>,
    ): Promise<T> {
      const owner = (await dataSource.query("SELECT current_user AS u"))[0].u;
      const bridge = `bridge_${Date.now()}_${bridgeSeq++}`;
      await dataSource.query(`CREATE ROLE ${bridge} NOLOGIN`);
      try {
        await dataSource.query(
          `GRANT ${owner} TO ${bridge} ${edges.ownerToBridge}`,
        );
        await dataSource.query(
          `GRANT ${bridge} TO ${TEST_APP_ROLE} ${edges.bridgeToApp}`,
        );
        return await fn(bridge);
      } finally {
        await dataSource
          .query(`REVOKE ${bridge} FROM ${TEST_APP_ROLE}`)
          .catch(() => undefined);
        await dataSource
          .query(`REVOKE ${owner} FROM ${bridge}`)
          .catch(() => undefined);
        await dataSource.query(`DROP ROLE ${bridge}`);
      }
    }

    it("refuses a SET-reachable bridge that inherits the owner (RR4-001)", async () => {
      await withBridge(
        {
          ownerToBridge: "WITH INHERIT TRUE, SET FALSE",
          bridgeToApp: "WITH INHERIT FALSE, SET TRUE",
        },
        async (bridge) => {
          const app = await appRolePool();
          try {
            const owner = (
              await dataSource.query("SELECT current_user AS u")
            )[0].u;
            // Neither direct predicate sees the owner from here. That is the
            // finding, asserted rather than described.
            const [reach] = await app.query(
              `SELECT pg_has_role(current_user, $1, 'SET') AS owner_set,
                      pg_has_role(current_user, $1, 'USAGE') AS owner_usage,
                      pg_has_role(current_user, $2, 'SET') AS bridge_set`,
              [owner, bridge],
            );
            expect(reach.owner_set).toBe(false);
            expect(reach.owner_usage).toBe(false);
            expect(reach.bridge_set).toBe(true);

            // Before the statement the boundary is intact...
            const [before] = await app.query(
              "SELECT row_security_active('accounts') AS active",
            );
            expect(before.active).toBe(true);

            // ...and one statement removes it. `SET LOCAL ROLE`, not `SET ROLE`:
            // the plain form is SESSION-scoped, so on a one-connection pool it
            // survives the commit and every later statement -- including the
            // startup check below -- would run as the bridge and measure the wrong
            // role entirely. That mistake is what made this test fail while the
            // SQL was already correct.
            const entered = await app.transaction(async (m) => {
              await m.query(
                "SELECT set_config('app.current_user_id', $1, true)",
                [USER_A],
              );
              await m.query(`SET LOCAL ROLE ${bridge}`);
              const [{ active }] = await m.query(
                "SELECT row_security_active('accounts') AS active",
              );
              const [{ n }] = await m.query(
                "SELECT count(*)::int AS n FROM accounts",
              );
              return { active, n };
            });
            expect(entered.active).toBe(false);
            expect(entered.n).toBe(2);

            // The demonstration must not have contaminated the measurement.
            const [{ who }] = await app.query("SELECT current_user AS who");
            expect(who).toBe(TEST_APP_ROLE);

            // Which the check must now refuse, naming the bridge -- the grant an
            // operator can actually revoke.
            const facts = await readRuntimeRoleFacts(app);
            expect(facts.exemptReachableContexts).toContain(bridge);
            expect(
              runtimeRoleViolations(facts, TEST_APP_ROLE).join(" "),
            ).toContain("SET ROLE");
          } finally {
            await app.destroy();
          }
        },
      );
    });

    it("refuses a mixed chain two bridges long (RR4-001)", async () => {
      // app --SET--> bridge_a --SET--> bridge_b --INHERIT--> owner. Both
      // pg_has_role calls are transitive, so the reachable set still contains
      // bridge_b and the ownership question is asked of it.
      const owner = (await dataSource.query("SELECT current_user AS u"))[0].u;
      const a = `bridge_a_${Date.now()}`;
      const b = `bridge_b_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${a} NOLOGIN`);
      await dataSource.query(`CREATE ROLE ${b} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${owner} TO ${b} WITH INHERIT TRUE, SET FALSE`,
        );
        await dataSource.query(
          `GRANT ${b} TO ${a} WITH INHERIT FALSE, SET TRUE`,
        );
        await dataSource.query(
          `GRANT ${a} TO ${TEST_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.exemptReachableContexts).toContain(b);
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${a} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`REVOKE ${b} FROM ${a}`);
        await dataSource.query(`REVOKE ${owner} FROM ${b}`);
        await dataSource.query(`DROP ROLE ${a}`);
        await dataSource.query(`DROP ROLE ${b}`);
      }
    });

    it("accepts a bridge that is reachable but not exempt (RR4-001 control)", async () => {
      // The control that stops the new predicate becoming a blanket rejection of
      // every membership: a SET-reachable role with no exemption of its own and no
      // inherited owner is harmless, and the tenant filter must stay on.
      const plain = `plain_bridge_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${plain} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${plain} TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.exemptReachableContexts).not.toContain(plain);
        expect(runtimeRoleViolations(facts, TEST_APP_ROLE)).toEqual([]);

        const visible = await app.transaction(async (m) => {
          await m.query("SELECT set_config('app.current_user_id', $1, true)", [
            USER_A,
          ]);
          const [{ n }] = await m.query(
            "SELECT count(*)::int AS n FROM accounts",
          );
          return n;
        });
        expect(visible).toBe(1);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${plain} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`DROP ROLE ${plain}`);
      }
    });

    it("accepts an unreachable bridge that inherits the owner (RR4-001 control)", async () => {
      // The other control: the bridge inherits the owner, but the runtime role can
      // neither become it nor inherit it, so no route exists and there is nothing
      // to report. Rejecting here would refuse to start over a graph the
      // connection cannot use.
      await withBridge(
        {
          ownerToBridge: "WITH INHERIT TRUE, SET FALSE",
          bridgeToApp: "WITH INHERIT FALSE, SET FALSE",
        },
        async (bridge) => {
          const app = await appRolePool();
          try {
            const facts = await readRuntimeRoleFacts(app);
            expect(facts.exemptReachableContexts).not.toContain(bridge);
            expect(facts.inheritedOwnerRoles).toEqual([]);
            expect(runtimeRoleViolations(facts, TEST_APP_ROLE)).toEqual([]);

            const [{ active }] = await app.query(
              "SELECT row_security_active('accounts') AS active",
            );
            expect(active).toBe(true);
          } finally {
            await app.destroy();
          }
        },
      );
    });

    it("does not report an inherited membership in a role that owns nothing policied", async () => {
      // The negative control for the USAGE arm. Inheriting from an ordinary group
      // confers no exemption, and reporting it would train the operator to ignore
      // the message -- the same reasoning that keeps rolsuper/rolbypassrls out of
      // this arm, since those are not inherited at all.
      const plain = `plain_group_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${plain} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${plain} TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedOwnerRoles).not.toContain(plain);
        expect(facts.exemptReachableContexts).not.toContain(plain);
        expect(runtimeRoleViolations(facts, TEST_APP_ROLE)).toEqual([]);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${plain} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`DROP ROLE ${plain}`);
      }
    });

    it("does not inherit BYPASSRLS, so that stays a SET-only question", async () => {
      // The assumption the split rests on. Verified rather than read: a member of
      // a BYPASSRLS role with INHERIT TRUE still has policies applied, because
      // role attributes are not privileges.
      const bypasser = `bypass_role_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${bypasser} NOLOGIN BYPASSRLS`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${bypasser} TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
        );

        const [observed] = await app.query(
          "SELECT row_security_active('accounts') AS rls_active",
        );
        expect(observed.rls_active).toBe(true);
        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedOwnerRoles).not.toContain(bypasser);
        // ...and it is not SET-reachable either, so nothing is reported.
        expect(facts.exemptReachableContexts).not.toContain(bypasser);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${bypasser} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`DROP ROLE ${bypasser}`);
      }
    });

    it("refuses a runtime role that holds REPLICATION, and proves the slot works (RR5-001)", async () => {
      // The forbidden attribute the verifier used not to read. First prove it is
      // real -- a NOSUPERUSER role with REPLICATION can create a WAL-retaining
      // physical slot -- then that the check now rejects it. The proof is what
      // makes this more than a string assertion: PostgreSQL, not the author,
      // decides the attribute is dangerous.
      const replicator = `repl_role_${Date.now()}`;
      await dataSource.query(
        `CREATE ROLE ${replicator} LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS REPLICATION`,
      );
      const replPool = new DataSource({
        ...INTEGRATION_TYPEORM_OPTIONS,
        username: replicator,
        password: "x",
        synchronize: false,
        dropSchema: false,
        extra: { max: 1 },
      } as never);
      await replPool.initialize();
      const slot = `rr5_slot_${Date.now()}`;
      try {
        // The concrete availability failure: a slot this role creates reserves
        // WAL. TEMPORARY (third arg true), because a non-temporary slot outlives
        // the test -- a SIGKILL before the `finally` cleanup would leave it
        // retaining WAL on a shared cluster until the disk fills, and replication
        // slots are cluster-wide, untouched by dropSchema (RR6-002). A temporary
        // slot still proves the capability -- it reserves WAL while the session
        // lives -- and PostgreSQL drops it automatically when the session ends.
        const [created] = await replPool.query(
          "SELECT slot_name FROM pg_create_physical_replication_slot($1, true, true)",
          [slot],
        );
        expect(created.slot_name).toBe(slot);
        // Temporary and reserving WAL while the session is alive. Read on the
        // creating connection: a temporary slot is owned by its session, so the
        // owner pool is where it is reliably visible.
        const [status] = await replPool.query(
          "SELECT temporary, wal_status FROM pg_replication_slots WHERE slot_name = $1",
          [slot],
        );
        expect(status?.temporary).toBe(true);
        expect(status?.wal_status).toBe("reserved");

        const facts = await readRuntimeRoleFacts(replPool);
        expect(facts.directForbiddenAttributes).toContain("REPLICATION");
        const violations = runtimeRoleViolations(facts, replicator);
        expect(violations.join(" ")).toContain("REPLICATION");
      } finally {
        // The ONLY cleanup is ending the session -- deliberately no explicit
        // pg_drop_replication_slot (DOC-RR7-001). An earlier version dropped the
        // slot here and then asserted absence, which proved nothing: a successful
        // explicit drop makes the slot disappear whether or not PostgreSQL would
        // have auto-dropped it. Removing the drop is what turns the assertion
        // below into evidence that a temporary slot is session-scoped.
        await replPool.destroy();
      }
      // Proven from a SECOND connection, and with nothing having dropped the slot
      // explicitly: it is gone because its session ended. Polled, because the
      // backend's slot cleanup races the client-side pool close.
      const slotGone = await waitFor(async () => {
        const [{ n }] = await dataSource.query(
          "SELECT count(*)::int AS n FROM pg_replication_slots WHERE slot_name = $1",
          [slot],
        );
        return n === 0;
      });
      expect(slotGone).toBe(true);
      await dataSource.query(`DROP ROLE ${replicator}`);
    });

    it("refuses a SET-reachable context that holds REPLICATION (RR5-001)", async () => {
      // The attribute is not inherited, so it only matters in a context that can
      // be entered -- but a reachable one is one SET ROLE from creating a slot,
      // exactly as a reachable exempt role is one SET ROLE from bypassing RLS.
      const replBridge = `repl_bridge_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${replBridge} NOLOGIN REPLICATION`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT ${replBridge} TO ${TEST_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.exemptReachableContexts).toContain(replBridge);
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${replBridge} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`DROP ROLE ${replBridge}`);
      }
    });

    it("refuses an inherited server-program membership, and proves COPY TO PROGRAM (RR6-001)", async () => {
      // OS command execution, and provisioning cannot strip it -- membership is a
      // GRANT, not an attribute, so the parity guard is silent and this is the
      // only defence. First prove the capability is live: a NOSUPERUSER member of
      // pg_execute_server_program runs a program on the host. Then that the check
      // rejects it. INHERIT TRUE, SET FALSE -- active now, no SET ROLE, so only a
      // USAGE question finds it.
      await dataSource.query(
        `GRANT pg_execute_server_program TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
      );
      const app = await appRolePool();
      const proof = `/tmp/monize-rr6-${Date.now()}`;
      try {
        // The harm, demonstrated. `COPY ... TO PROGRAM` runs as the PostgreSQL OS
        // account; a NOSUPERUSER role could not do this without the membership.
        await app.query(`COPY (SELECT 'rr6') TO PROGRAM 'cat > ${proof}'`);
        const [{ proven }] = await dataSource.query(
          `SELECT pg_read_file($1) AS proven`,
          [proof],
        );
        expect(proven).toContain("rr6");

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain(
          "pg_execute_server_program",
        );
        const message = runtimeRoleViolations(facts, TEST_APP_ROLE).join(" ");
        expect(message).toContain("pg_execute_server_program");
        expect(message).toContain("COPY");
        expect(message).toContain("Revoke the membership");
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_execute_server_program FROM ${TEST_APP_ROLE}`,
        );
        await dataSource
          .query(`COPY (SELECT 1) TO PROGRAM 'rm -f ${proof}'`)
          .catch(() => undefined);
      }
    });

    it("refuses a SET-reachable bridge that inherits a server-program membership (RR6-001)", async () => {
      // app --SET--> bridge --INHERIT--> pg_execute_server_program. The bridge
      // owns nothing and has no forbidden attribute; only the forbidden-membership
      // USAGE question on the reachable context finds it.
      const bridge = `srvprog_bridge_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${bridge} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT pg_execute_server_program TO ${bridge} WITH INHERIT TRUE, SET FALSE`,
        );
        await dataSource.query(
          `GRANT ${bridge} TO ${TEST_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        // Not held now (the app->bridge edge is INHERIT FALSE)...
        expect(facts.inheritedForbiddenRoles).toEqual([]);
        // ...but reachable, and that is a refusal.
        expect(facts.exemptReachableContexts).toContain(bridge);
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${bridge} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(
          `REVOKE pg_execute_server_program FROM ${bridge}`,
        );
        await dataSource.query(`DROP ROLE ${bridge}`);
      }
    });

    it("refuses an inherited pg_signal_backend membership, and proves it can terminate another role's session (RR7-001)", async () => {
      // The capability that has nothing to do with RLS, no forbidden attribute,
      // and no ownership -- so only the membership arm sees it. A member can
      // pg_terminate_backend a session owned by ANY other non-superuser role
      // (migrations, backups, other apps), which a bare NOSUPERUSER role cannot.
      // Prove the capability against a live victim session, then that the check
      // rejects it. INHERIT TRUE, SET FALSE -- active now, no SET ROLE.
      const victim = `rr7_victim_${Date.now()}`;
      await dataSource.query(
        `CREATE ROLE ${victim} LOGIN PASSWORD 'x' NOSUPERUSER NOBYPASSRLS`,
      );
      const victimPool = new DataSource({
        ...INTEGRATION_TYPEORM_OPTIONS,
        username: victim,
        password: "x",
        synchronize: false,
        dropSchema: false,
        extra: { max: 1 },
      } as never);
      await victimPool.initialize();
      const app = await appRolePool();
      try {
        const [{ pid }] = await victimPool.query(
          "SELECT pg_backend_pid()::int AS pid",
        );

        await dataSource.query(
          `GRANT pg_signal_backend TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
        );

        // The harm, demonstrated: the app terminates a DIFFERENT role's backend.
        // A NOSUPERUSER role without this membership gets "must be a member of
        // pg_signal_backend" instead of a boolean.
        const [{ terminated }] = await app.query(
          "SELECT pg_terminate_backend($1) AS terminated",
          [pid],
        );
        expect(terminated).toBe(true);
        // ...and the victim's session really is gone from the cluster.
        const victimGone = await waitFor(async () => {
          const [{ n }] = await dataSource.query(
            "SELECT count(*)::int AS n FROM pg_stat_activity WHERE pid = $1",
            [pid],
          );
          return n === 0;
        });
        expect(victimGone).toBe(true);

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain("pg_signal_backend");
        const message = runtimeRoleViolations(facts, TEST_APP_ROLE).join(" ");
        expect(message).toContain("pg_signal_backend");
        expect(message).toContain("terminate sessions");
        expect(message).toContain("Revoke the membership");
      } finally {
        await app.destroy();
        await victimPool.destroy().catch(() => undefined);
        await dataSource.query(
          `REVOKE pg_signal_backend FROM ${TEST_APP_ROLE}`,
        );
        await dataSource.query(`DROP ROLE IF EXISTS ${victim}`);
      }
    });

    it("refuses an inherited pg_maintain membership, and proves it reaches a table the role was never granted", async () => {
      // pg_maintain (PostgreSQL 17+) grants MAINTAIN on every relation in the
      // cluster. Prove the reach on a table the app role holds no privilege on,
      // then that the check rejects the membership. INHERIT TRUE, SET FALSE.
      const table = `pgm_target_${Date.now()}`;
      await dataSource.query(`CREATE TABLE ${table} (id integer PRIMARY KEY)`);
      const app = await appRolePool();
      try {
        await expect(app.query(`REINDEX TABLE ${table}`)).rejects.toThrow(
          /must be owner|permission denied/,
        );

        await dataSource.query(
          `GRANT pg_maintain TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
        );
        // The harm, demonstrated: the same statement now succeeds.
        await app.query(`REINDEX TABLE ${table}`);

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain("pg_maintain");
        const message = runtimeRoleViolations(facts, TEST_APP_ROLE).join(" ");
        expect(message).toContain("pg_maintain");
        expect(message).toContain("Revoke the membership");
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE pg_maintain FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`DROP TABLE IF EXISTS ${table}`);
      }
    });

    it("refuses a SET-only pg_signal_backend membership (RR7-001)", async () => {
      // INHERIT FALSE, SET TRUE: not held now, but one SET ROLE away from the
      // capability, so it is a reachable-context refusal like every other.
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT pg_signal_backend TO ${TEST_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toEqual([]);
        expect(facts.exemptReachableContexts).toContain("pg_signal_backend");
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_signal_backend FROM ${TEST_APP_ROLE}`,
        );
      }
    });

    it("refuses a SET-reachable bridge that inherits pg_signal_backend (RR7-001)", async () => {
      // app --SET--> bridge --INHERIT--> pg_signal_backend. The composition arm:
      // the bridge owns nothing and has no forbidden attribute, so only the
      // forbidden-membership USAGE question on the reachable context finds it.
      const bridge = `signal_bridge_${Date.now()}`;
      await dataSource.query(`CREATE ROLE ${bridge} NOLOGIN`);
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT pg_signal_backend TO ${bridge} WITH INHERIT TRUE, SET FALSE`,
        );
        await dataSource.query(
          `GRANT ${bridge} TO ${TEST_APP_ROLE} WITH INHERIT FALSE, SET TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toEqual([]);
        expect(facts.exemptReachableContexts).toContain(bridge);
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(`REVOKE ${bridge} FROM ${TEST_APP_ROLE}`);
        await dataSource.query(`REVOKE pg_signal_backend FROM ${bridge}`);
        await dataSource.query(`DROP ROLE ${bridge}`);
      }
    });

    it("refuses an inherited pg_read_server_files membership, and proves it can read a host file (RR7-001)", async () => {
      // The read half of the file-role pair. The capability the role actually
      // grants is `COPY ... FROM '<absolute path>'` -- a bare NOSUPERUSER role is
      // refused an absolute path outright. Write the file as the owner, then read
      // it into a temp table as the app to demonstrate what the membership adds.
      const proof = `/tmp/monize-rr7-read-${Date.now()}`;
      await dataSource.query(
        `COPY (SELECT 'rr7-read') TO PROGRAM 'cat > ${proof}'`,
      );
      await dataSource.query(
        `GRANT pg_read_server_files TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
      );
      const app = await appRolePool();
      try {
        const contents = await app.transaction(async (m) => {
          await m.query("CREATE TEMP TABLE rr7_read_probe (line text)");
          await m.query(`COPY rr7_read_probe FROM '${proof}'`);
          const [{ line }] = await m.query("SELECT line FROM rr7_read_probe");
          return line as string;
        });
        expect(contents).toContain("rr7-read");

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain("pg_read_server_files");
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_read_server_files FROM ${TEST_APP_ROLE}`,
        );
        await dataSource
          .query(`COPY (SELECT 1) TO PROGRAM 'rm -f ${proof}'`)
          .catch(() => undefined);
      }
    });

    it("refuses an inherited pg_write_server_files membership, and proves it can write a host file (RR7-001)", async () => {
      // The write half. A member can COPY ... TO an absolute path; a bare
      // NOSUPERUSER role gets "absolute path not allowed". Write as the app, then
      // read it back as the owner to prove the file landed on the host.
      const proof = `/tmp/monize-rr7-write-${Date.now()}`;
      await dataSource.query(
        `GRANT pg_write_server_files TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
      );
      const app = await appRolePool();
      try {
        await app.query(`COPY (SELECT 'rr7-write') TO '${proof}'`);
        const [{ proven }] = await dataSource.query(
          "SELECT pg_read_file($1) AS proven",
          [proof],
        );
        expect(proven).toContain("rr7-write");

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain(
          "pg_write_server_files",
        );
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_write_server_files FROM ${TEST_APP_ROLE}`,
        );
        await dataSource
          .query(`COPY (SELECT 1) TO PROGRAM 'rm -f ${proof}'`)
          .catch(() => undefined);
      }
    });

    it("refuses an inherited pg_read_all_settings membership (DR-RR7-001)", async () => {
      // Reclassified from accepted to forbidden: on a standby whose
      // primary_conninfo carries a replication password, a member can read that
      // credential through SHOW / current_setting / pg_settings. Forbidding it is
      // the deployment-independent control.
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT pg_read_all_settings TO ${TEST_APP_ROLE} WITH INHERIT TRUE, SET FALSE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toContain("pg_read_all_settings");
        expect(
          runtimeRoleViolations(facts, TEST_APP_ROLE).length,
        ).toBeGreaterThan(0);
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_read_all_settings FROM ${TEST_APP_ROLE}`,
        );
      }
    });

    it("accepts membership in a deliberately-safe predefined role like pg_read_all_stats", async () => {
      // The control that keeps the forbidden list an allowlist rather than "every
      // pg_* role": a role classified KNOWN_SAFE_PREDEFINED_ROLES confers no
      // escalation and must not stop the app booting. pg_read_all_settings used to
      // play this role and is now forbidden (DR-RR7-001), so the control moved to a
      // genuinely inert monitoring role.
      const app = await appRolePool();
      try {
        await dataSource.query(
          `GRANT pg_read_all_stats TO ${TEST_APP_ROLE} WITH INHERIT TRUE`,
        );

        const facts = await readRuntimeRoleFacts(app);
        expect(facts.inheritedForbiddenRoles).toEqual([]);
        expect(facts.exemptReachableContexts).toEqual([]);
        expect(runtimeRoleViolations(facts, TEST_APP_ROLE)).toEqual([]);
      } finally {
        await app.destroy();
        await dataSource.query(
          `REVOKE pg_read_all_stats FROM ${TEST_APP_ROLE}`,
        );
      }
    });

    it("classifies every predefined role in this PostgreSQL, forbidden or safe (DR-RR7-002)", async () => {
      // The list must not silently fall behind PostgreSQL. Every live pg_* role
      // that is a member of `pg_read_all_stats` or otherwise a genuine predefined
      // role has to appear in exactly one of the two documented lists, so a new
      // PostgreSQL version's new predefined role forces a decision here instead of
      // defaulting to safe-by-omission. Read the catalog, subtract the two lists,
      // and require an empty remainder.
      const rows: Array<{ rolname: string }> = await dataSource.query(
        // Predefined roles are exactly the pinned system roles: catalog oid below
        // the first user oid (16384) and a pg_ name.
        `SELECT rolname FROM pg_roles
          WHERE rolname LIKE 'pg\\_%' AND oid < 16384
          ORDER BY rolname`,
      );
      const live = rows.map((r) => r.rolname);
      expect(live.length).toBeGreaterThan(0);

      const classified = new Set<string>([
        ...FORBIDDEN_ROLE_MEMBERSHIPS.map((m) => m.role),
        ...KNOWN_SAFE_PREDEFINED_ROLES,
      ]);
      const unclassified = live.filter((r) => !classified.has(r));
      // A failure here means PostgreSQL shipped a predefined role neither list
      // knows about -- classify it in runtime-role-check.ts before shipping.
      expect(unclassified).toEqual([]);
    });
  });
});
