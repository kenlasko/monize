import * as fs from "fs";
import * as path from "path";
import { DataSource } from "typeorm";

import { applyAppRoleGrants, provisionAppRole } from "@/common/db/app-role";
import { DEFAULT_APP_USER } from "@/common/db/rls-config";

/**
 * RLS task T1: make the integration harness look like a real database.
 *
 * `synchronize: true` builds the schema from entity metadata, which gives the
 * integration suites tables and columns but **none** of the database objects
 * that only exist in SQL: no `monize_app` role, no grants, no RLS helper
 * functions, no policies, and no `updated_at` triggers. Every one of those is
 * something the RLS work depends on, so without this step T2's enforcement
 * assertions and C5's restore acceptance would pass vacuously against a
 * database that simply has nothing to enforce.
 *
 * What this does NOT do is enable row-level security. The policies ship inert
 * (M2) and the enable is its own migration (M3, flip B), so applying policies
 * here leaves every existing suite behaving exactly as it did -- a policy on a
 * table without `ENABLE ROW LEVEL SECURITY` is never consulted by the planner.
 * A spec that wants enforcement opts into it explicitly.
 */

const MIGRATIONS_DIR = path.join(__dirname, "../../../database/migrations");
const SCHEMA_SQL = path.join(__dirname, "../../../database/schema.sql");

/**
 * Password for the test-only runtime role. Not a secret: the role exists in the
 * throwaway `monize_test` database so specs can `SET LOCAL ROLE` to a non-owner
 * and observe policies actually filtering (the owner bypasses RLS).
 */
export const TEST_APP_ROLE_PASSWORD = "monize_test_app_password";

/** Role name the harness provisions, matching the app's default. */
export const TEST_APP_ROLE = process.env.DATABASE_APP_USER || DEFAULT_APP_USER;

/**
 * Selects the migrations that carry RLS objects, by **content** rather than by
 * filename.
 *
 * A `*_rls_*.sql` glob is the obvious approach and it is wrong: it matches
 * `111`-`114` and `118_security_documents_rls.sql` but misses the policies for
 * `import_staged_files` and `import_jobs`, which live inside
 * `117_mny_import_staging_and_jobs.sql` -- a feature migration that creates two
 * tables and policies them in the same file. That is the *correct* pattern for
 * a new table (the policy ships with the table that needs it), so the harness
 * has to find policies wherever they are, not where a naming convention says
 * they should be.
 *
 * Every RLS object references one of the identity helpers -- each policy
 * predicate calls `app_current_user_id()` or `app_bypass_rls()`, and the
 * helpers' own migration defines them -- so that reference is one marker. A
 * `CREATE FUNCTION` is the other: a SQL function is by definition something
 * entity synchronization cannot produce, which is exactly what this harness
 * exists to install, whether or not the function has anything to do with RLS.
 * Together they select the right files today and pick up any future migration
 * that policies a new table or adds a helper, with no per-file registration to
 * forget.
 */
/**
 * SQL with comments removed, for content detection only.
 *
 * Required, not cosmetic: the policy migrations *document* the enable step in
 * prose ("inert until ALTER TABLE ... ENABLE ROW LEVEL SECURITY runs"), so a
 * marker test against the raw text classifies `112`-`118` as enable migrations
 * and drops every policy in them. That failure is silent -- the harness applies
 * fewer files and the suite goes green with two tables unpolicied.
 */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

/**
 * Migrations that install a **behavioural trigger** -- a rule enforced by the
 * database rather than by the entities.
 *
 * `synchronize` builds the schema from entity metadata and creates no triggers at
 * all, so every such rule is simply absent from a test database unless the harness
 * puts it there. That is not a cosmetic gap: migration 141's trigger is the only
 * thing that fences a *previous-version* import worker during a rolling deployment
 * (audit RRV4-001), and a suite that silently lacks it would report the fence as
 * working while nothing enforced it.
 *
 * Selected by content marker (`RETURNS TRIGGER`) for the same reason the RLS files
 * are: a new migration that adds a trigger is picked up with no per-file
 * registration to forget. Overlap with the RLS set is harmless -- every migration
 * body is required to be re-runnable.
 */
export function findTriggerMigrations(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found at ${MIGRATIONS_DIR}`);
  }
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      /RETURNS\s+TRIGGER/i.test(
        stripSqlComments(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")),
      ),
    );

  if (files.length === 0) {
    throw new Error(
      `No trigger migrations found in ${MIGRATIONS_DIR}. The harness applies them by ` +
        "content marker (RETURNS TRIGGER); finding none means either the migrations " +
        "are missing or the marker changed.",
    );
  }
  return files.map((f) => path.join(MIGRATIONS_DIR, f));
}

export function findRlsMigrations(includeEnable = false): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found at ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    // Filename order, which is what db-migrate uses -- note that `116_*` and
    // `117_*` each have two files, so numeric-prefix order is ambiguous and
    // alphabetical tie-breaking is what keeps `117_security_documents` ahead of
    // `118_security_documents_rls`.
    .sort();

  const rlsFiles = files.filter((f) => {
    const sql = stripSqlComments(
      fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"),
    );
    // A file that references a helper declares a policy, and that settles it --
    // the test asked first, because a migration numbered after M3 has to ship
    // its own ENABLE alongside its policy (database/CLAUDE.md) and would
    // otherwise be read as an enable migration and dropped from the default
    // apply, leaving its table unpolicied while the suite went green.
    if (/app_current_user_id|app_bypass_rls/.test(sql)) return true;
    // A migration that defines a SQL function is, by this harness's own
    // definition, a database object entity synchronization cannot produce -- so
    // it belongs here whether or not it touches RLS. Without this, migration
    // 133's `currency_code_in_use_globally` is absent from the test database and
    // every spec whose code path calls it fails on "function does not exist",
    // which reads as a bug in the caller rather than a gap in the harness.
    if (/CREATE (?:OR REPLACE )?FUNCTION/i.test(sql)) return true;
    // The enable migration (M3) references neither helper -- it reads
    // pg_policies -- so it is opted into separately, and applied in its
    // filename position rather than appended. Position is what makes the
    // "policy without its own enable" guard meaningful: M3's loop enables what
    // is policied *when it runs*, so a later migration adding a policy without
    // an enable leaves that table unenforced, exactly as it would on a deployed
    // database where M3 has already been recorded in schema_migrations.
    if (/ENABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql)) return includeEnable;
    return false;
  });

  if (rlsFiles.length === 0) {
    throw new Error(
      `No RLS migrations found in ${MIGRATIONS_DIR}. The harness applies migrations ` +
        "by content marker (app_current_user_id / app_bypass_rls / CREATE FUNCTION); " +
        "finding none means either the migrations are missing or the marker changed.",
    );
  }

  return rlsFiles.map((f) => path.join(MIGRATIONS_DIR, f));
}

/**
 * Table names each migration file declares a policy for, in both shapes the
 * migrations use: an explicit `CREATE POLICY x ON t`, and the `DO` block in
 * `112` that loops a `text[]` of table names through `EXECUTE format(...)`.
 * Used as a post-condition -- what was declared has to exist in `pg_policies`
 * once the files have been applied.
 */
export function declaredPolicyTables(rawSql: string): string[] {
  // Comments stripped for the same reason as in the selector: these files
  // discuss policies in prose, and a sentence naming one would become a
  // post-condition demanding a policy nothing creates.
  const sql = stripSqlComments(rawSql);
  const tables = new Set<string>();

  // `CREATE POLICY name ON table` -- deliberately not `POLICY ... ON`, which
  // would also match the `DROP POLICY IF EXISTS` that precedes each one.
  for (const match of sql.matchAll(/CREATE\s+POLICY\s+\w+\s+ON\s+(\w+)/gi)) {
    tables.add(match[1]);
  }

  // The looped form: a `text[] := ARRAY[...]` of table names in a file whose
  // DO block builds a CREATE POLICY through `format()`.
  if (/EXECUTE\s+format\(/i.test(sql) && /'CREATE POLICY/i.test(sql)) {
    for (const arrayMatch of sql.matchAll(
      /text\[\]\s*:=\s*ARRAY\[([^\]]*)\]/gi,
    )) {
      for (const name of arrayMatch[1].matchAll(/'(\w+)'/g)) {
        tables.add(name[1]);
      }
    }
  }

  return [...tables];
}

/**
 * The `updated_at` triggers, extracted from `schema.sql`.
 *
 * `synchronize` creates no database triggers at all -- `@UpdateDateColumn`
 * stamps the column app-side -- and the RLS migrations only replace the trigger
 * *function*, never attach it to a table that has no trigger yet. So without
 * this step the GUC-aware trigger from M1 exists but fires nowhere, and any
 * assertion about `app.preserve_timestamps` (T2) or about restore preserving
 * timestamps (C5) would pass without testing anything.
 *
 * The DDL is read from `schema.sql` rather than rebuilt from a list here, so a
 * table that gains a trigger gains it in the harness too.
 */
function updatedAtTriggers(): { trigger: string; table: string }[] {
  if (!fs.existsSync(SCHEMA_SQL)) {
    throw new Error(`Schema not found at ${SCHEMA_SQL}`);
  }
  const sql = fs.readFileSync(SCHEMA_SQL, "utf8");

  // Whitespace-tolerant: schema.sql has these in both one-line and multi-line
  // form, and the two are otherwise identical.
  const pattern =
    /CREATE\s+TRIGGER\s+(\w+)\s+BEFORE\s+UPDATE\s+ON\s+(\w+)\s+FOR\s+EACH\s+ROW\s+EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+update_updated_at_column\(\)/gi;

  const triggers = [...sql.matchAll(pattern)].map((m) => ({
    trigger: m[1],
    table: m[2],
  }));

  if (triggers.length === 0) {
    throw new Error(
      `No updated_at triggers found in ${SCHEMA_SQL}. The extraction pattern and the ` +
        "schema have diverged; fix the pattern rather than skipping the triggers, or " +
        "every timestamp assertion downstream passes vacuously.",
    );
  }

  return triggers;
}

/**
 * Brings a `synchronize`-built test database up to the shape the real one has:
 * the runtime role and its grants, the RLS helper functions and policies, the
 * behavioural triggers that enforce rules the entities cannot express, and the
 * `updated_at` triggers.
 *
 * Call after the schema exists (i.e. after `DataSource.initialize()` with
 * `synchronize: true`). Idempotent, and re-applied per suite because
 * `dropSchema: true` takes the functions, policies and triggers down with the
 * tables on every suite start.
 *
 * `includeEnable` opts into the M3 enable migration, which is off by default so
 * the ordinary suites keep seeing inert policies. Note that even with it on,
 * the *owner* still bypasses RLS -- a spec that wants to observe filtering has
 * to `SET LOCAL ROLE` to the runtime role.
 */
export async function applyRlsPolicies(
  dataSource: DataSource,
  { includeEnable = false }: { includeEnable?: boolean } = {},
): Promise<void> {
  // 1. The role first: the grants below are meaningless without it, and a spec
  //    doing `SET LOCAL ROLE monize_app` needs it to exist. Never throws on a
  //    privilege shortfall -- it warns -- so the grant assertion below is what
  //    actually proves it worked.
  await provisionAppRole(dataSource, {
    appUser: TEST_APP_ROLE,
    appPassword: TEST_APP_ROLE_PASSWORD,
    logger: { log: () => {}, warn: () => {} },
  });

  const [{ exists: roleExists }] = await dataSource.query(
    "SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [TEST_APP_ROLE],
  );
  if (!roleExists) {
    throw new Error(
      `Runtime role '${TEST_APP_ROLE}' was not created. The test database owner needs ` +
        "CREATEROLE; without the role, enforcement specs cannot switch off owner bypass.",
    );
  }

  // 2. The RLS migrations, read from disk so the harness can never drift from
  //    what ships.
  const migrations = findRlsMigrations(includeEnable);
  const declared = new Set<string>();

  for (const file of migrations) {
    const sql = fs.readFileSync(file, "utf8");
    try {
      await dataSource.query(sql);
    } catch (err) {
      // Name the file: a bare Postgres error in a 6-file apply is unhelpful.
      throw new Error(
        `Failed applying RLS migration ${path.basename(file)}: ${(err as Error).message}`,
      );
    }
    for (const table of declaredPolicyTables(sql)) {
      declared.add(table);
    }
  }

  // 2b. Re-apply the grants, for the same reason db-migrate does: step 1 ran
  //     before the migrations, so EXECUTE on a function one of them creates (and
  //     revokes from PUBLIC) was granted to nothing. An enforcement spec calling
  //     it as the runtime role would get "permission denied for function".
  await applyAppRoleGrants(dataSource, { appUser: TEST_APP_ROLE });

  // 3. Post-condition: every policy the applied files declare exists in the
  //    database. Catches a file that applied without error but whose DO block
  //    took a branch that skipped the policies, and any future shape of
  //    migration the extraction above does not understand.
  const policied = new Set<string>(
    (
      await dataSource.query(
        "SELECT DISTINCT tablename FROM pg_policies WHERE schemaname = 'public'",
      )
    ).map((r: { tablename: string }) => r.tablename),
  );
  const missing = [...declared].filter((t) => !policied.has(t)).sort();
  if (missing.length > 0) {
    throw new Error(
      `RLS migrations declare policies for tables that have none after apply: ${missing.join(", ")}.`,
    );
  }

  // 4. Behavioural triggers, which synchronize never creates either. Applied after
  //    the policies because one of them (136's tombstone recorder) is SECURITY
  //    DEFINER and its own migration is already in the set above; re-applying is a
  //    no-op by the idempotency rule every migration follows.
  for (const file of findTriggerMigrations()) {
    try {
      await dataSource.query(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(
        `Failed applying trigger migration ${path.basename(file)}: ${(err as Error).message}`,
      );
    }
  }

  // 5. The updated_at triggers, which synchronize never creates.
  for (const { trigger, table } of updatedAtTriggers()) {
    // Skip a table the entities do not produce -- the harness synchronizes from
    // entity metadata, so schema.sql can legitimately be ahead of it.
    const [{ exists: tableExists }] = await dataSource.query(
      "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1) AS exists",
      [table],
    );
    if (!tableExists) continue;

    await dataSource.query(`DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`);
    await dataSource.query(
      `CREATE TRIGGER "${trigger}" BEFORE UPDATE ON "${table}"
       FOR EACH ROW EXECUTE FUNCTION update_updated_at_column()`,
    );
  }
}
