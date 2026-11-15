import { DEFAULT_APP_USER, RlsMode } from "./rls-config";

/**
 * Startup verification that `RLS_MODE=enforce` is actually enforcing.
 *
 * Selecting the application role and supplying its password is not the same as
 * connecting under one: PostgreSQL exempts a superuser, a role with `BYPASSRLS`,
 * and the owner of a table (unless the table is `FORCE ROW LEVEL SECURITY`) from
 * every policy on it. An operator who points `DATABASE_APP_USER` at the database
 * owner, or at a pre-existing role that happens to hold `BYPASSRLS`, gets a
 * successful boot, a log line saying enforce, and no database-level tenant
 * boundary at all (P2-006). Provisioning cannot substitute for this check: a
 * role that already exists is only altered, the deployment may provision the
 * role declaratively (CNPG `managed.roles`) where the application never touches
 * it, and an attribute granted after startup is invisible either way.
 *
 * So the runtime asks the database, over the connection it will actually serve
 * requests on, what it is -- and refuses to start when the answer is not the
 * unprivileged role the mode promises. Fail closed: a wrong answer here means
 * every later query silently sees every tenant.
 *
 * At `off`/`shadow` the runtime connects as the owner on purpose, so the check
 * is skipped by design.
 */

/** Minimal query surface shared by `DataSource`, `pg.Client` and test doubles. */
export interface RuntimeRoleQuerier {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/**
 * Role attributes the unprivileged-role contract forbids, as data.
 *
 * These are the `NO<x>` attributes `APP_ROLE_ATTRIBUTES` strips at provisioning
 * (all but `NOINHERIT`, which is handled by the ownership-inheritance arms
 * rather than as a forbidden attribute). Kept as one list so the SQL that reads
 * them, the violation messages, and the parity guard in `app-role.spec.ts` all
 * derive from a single source -- a `NO<x>` added to provisioning without an
 * entry here fails that guard, which is what stops the verifier drifting behind
 * the contract it enforces (RR5-001, where `rolreplication` was provisioned off
 * but never checked, so a `REPLICATION` role passed startup and could hold WAL).
 *
 * None of these are inherited -- PostgreSQL applies role *attributes* only to the
 * role itself and after `SET ROLE`, never through `INHERIT` -- so each is tested
 * directly on the runtime role and on every `SET`-reachable context, and never
 * through `USAGE`.
 */
export const FORBIDDEN_RUNTIME_ATTRIBUTES = [
  {
    column: "rolsuper",
    label: "SUPERUSER",
    why: "is exempt from every row-level-security policy",
  },
  {
    column: "rolbypassrls",
    label: "BYPASSRLS",
    why: "is exempt from every row-level-security policy",
  },
  {
    column: "rolreplication",
    label: "REPLICATION",
    why: "can create WAL-retaining replication slots and open change streams, outside the tenant model",
  },
  {
    column: "rolcreaterole",
    label: "CREATEROLE",
    why: "can create and alter roles, a privilege-escalation surface the unprivileged runtime role must not have",
  },
  {
    column: "rolcreatedb",
    label: "CREATEDB",
    why: "can create databases outside the tenant model",
  },
] as const;

/**
 * Predefined roles whose *membership* -- not any attribute -- grants a capability
 * the application runtime role must never hold.
 *
 * These are the server-file and server-program roles: a member of
 * `pg_execute_server_program` can `COPY ... TO/FROM PROGRAM`, running commands as
 * the PostgreSQL OS account (RR6-001, measured -- a NOSUPERUSER role wrote a file
 * on the host), and the file roles read or write anything that account can. They
 * are reached the same way ownership is, so they are checked the same way:
 *
 * - `pg_has_role(role, forbidden, 'USAGE')` -- held now by inheritance, any depth;
 * - reachable via `SET ROLE` into a context that has that `USAGE`.
 *
 * Crucially, provisioning cannot strip these: `ALTER ROLE ... NO<x>` changes
 * *attributes*, and a membership is a `GRANT`/`REVOKE`. So the parity guard that
 * covers `FORBIDDEN_RUNTIME_ATTRIBUTES` says nothing here, and the runtime check
 * is the only line of defence -- which is exactly why it must exist.
 *
 * Deliberately a short, named allowlist of the dangerous ones rather than "every
 * `pg_*` role": `pg_monitor` and friends are not escalation paths, and refusing
 * to boot on a monitoring grant would train operators to ignore the check.
 */
export const FORBIDDEN_ROLE_MEMBERSHIPS = [
  {
    role: "pg_execute_server_program",
    why: "can COPY ... TO/FROM PROGRAM, executing commands as the PostgreSQL OS account",
  },
  {
    role: "pg_read_server_files",
    why: "can read any file the PostgreSQL OS account can, bypassing database permission checks",
  },
  {
    role: "pg_write_server_files",
    why: "can write any file the PostgreSQL OS account can, bypassing database permission checks",
  },
  {
    role: "pg_signal_backend",
    why: "can cancel queries and terminate sessions of other non-superuser roles across the cluster (RR7-001)",
  },
  {
    role: "pg_read_all_settings",
    why: "can read every configuration variable, including superuser-only values such as a standby's primary_conninfo password",
  },
  {
    role: "pg_read_all_data",
    why: "holds SELECT on every table in the cluster, reaching data outside the application's own",
  },
  {
    role: "pg_write_all_data",
    why: "holds INSERT/UPDATE/DELETE on every table in the cluster, reaching data outside the application's own",
  },
  {
    role: "pg_checkpoint",
    why: "can force immediate checkpoints, which PostgreSQL states are not for normal operation",
  },
  {
    role: "pg_create_subscription",
    why: "can create logical-replication subscriptions that ingest data outside the tenant model",
  },
  {
    role: "pg_monitor",
    why: "is an umbrella granting pg_read_all_settings and other monitoring roles, so it reaches forbidden capability",
  },
  {
    // PostgreSQL 17+. Absent on 16, where the name simply matches no row.
    role: "pg_maintain",
    why: "can VACUUM, ANALYZE, CLUSTER, REINDEX, REFRESH MATERIALIZED VIEW and LOCK TABLE on every relation in the cluster, including tables it does not own",
  },
  {
    // PostgreSQL 18+. The autovacuum counterpart of pg_signal_backend.
    role: "pg_signal_autovacuum_worker",
    why: "can cancel or terminate autovacuum workers across the cluster, holding back the vacuuming every database depends on",
  },
] as const;

/**
 * The predefined roles a member may safely hold, classified deliberately rather
 * than allowed by omission (DR-RR7-002). Together with
 * `FORBIDDEN_ROLE_MEMBERSHIPS` this covers every PostgreSQL 18 `pg_*` role, and
 * `runtime-role.integration.spec.ts` fails when the live catalog holds
 * a `pg_*` predefined role that appears in neither list -- so a future
 * PostgreSQL's new predefined role forces a decision instead of defaulting to
 * safe. These are monitoring or minor-availability capabilities that cross no
 * tenant, host, or cluster-control boundary.
 */
export const KNOWN_SAFE_PREDEFINED_ROLES = [
  "pg_read_all_stats",
  "pg_stat_scan_tables",
  "pg_use_reserved_connections",
  // Not independently grantable; its sole implicit member is the database owner,
  // which the ownership arm already refuses.
  "pg_database_owner",
] as const;

export interface RuntimeRoleFacts {
  /** The role the connection is actually authenticated as. */
  currentUser: string;
  /**
   * Labels from `FORBIDDEN_RUNTIME_ATTRIBUTES` the runtime role holds directly,
   * e.g. `["REPLICATION"]`. Empty for a correctly provisioned role.
   */
  directForbiddenAttributes: string[];
  /** True when this role owns the database it is connected to. */
  ownsDatabase: boolean;
  /**
   * How many tables with RLS enabled this role owns. A table's owner is exempt
   * from its policies unless the table is FORCE ROW LEVEL SECURITY, which this
   * schema deliberately does not use (owner/migration operations run outside
   * enforcement by design), so owning even one policied table is a hole.
   */
  ownedPoliciedTables: number;
  /**
   * Role contexts this connection can *enter* with `SET ROLE` that are unsafe
   * once entered -- exempt from RLS, or holding a forbidden attribute.
   *
   * "Judged on what it can do once entered" is the whole point, and it is what
   * the earlier version got wrong (RR4-001): a context is judged on its own
   * privileges, not on whether the catalog names it as an owner. `bridge` may
   * own nothing while inheriting the owner, and `SET ROLE bridge` then lands in a
   * context that bypasses every policy. It also covers a reachable context that
   * merely holds a forbidden attribute like `REPLICATION` (RR5-001).
   *
   * Nothing in this application issues `SET ROLE`, but an injected statement or a
   * mistaken raw query gets it for free, so it stays a refusal.
   *
   * Transitive in both modes, so a chain of any length is covered where a direct
   * `pg_auth_members` join sees only the first hop (DR-R1).
   */
  exemptReachableContexts: string[];
  /**
   * Owner roles whose privileges this role **already holds by inheritance**.
   *
   * The more dangerous half, and the one `SET` reachability cannot see (RR3-001).
   * PostgreSQL decides "is the current role the table owner" with
   * `object_ownercheck` -> `has_privs_of_role`, which walks inheritable
   * memberships -- so an inherited owner is an owner *now*, with no `SET ROLE` and
   * nothing to detect at the statement level. Measured on a live server:
   * `GRANT owner TO app WITH INHERIT TRUE, SET FALSE` gives `SET=false`,
   * `USAGE=true`, `row_security_active=false`, and both tenants' rows.
   *
   * The remedy differs from the list above, which is why it is a separate field:
   * revoking is one option, `WITH INHERIT FALSE` on the membership is the other.
   */
  inheritedOwnerRoles: string[];
  /**
   * Forbidden predefined roles (`FORBIDDEN_ROLE_MEMBERSHIPS`) this role holds now
   * by inheritance -- server-program / server-file capability that is active with
   * no `SET ROLE` (RR6-001). Reached like inherited ownership, reported
   * separately because the remedy is `REVOKE`, not `WITH INHERIT FALSE`.
   */
  inheritedForbiddenRoles: string[];
}

/**
 * Forbidden-attribute columns, as SQL fragments generated from the one list, so
 * a new entry there reaches the query with no second edit. `r.<col> AS <col>`
 * for the direct read, and `h.<col> OR ...` for the reachable-context test.
 */
const FORBIDDEN_ATTR_DIRECT_COLUMNS = FORBIDDEN_RUNTIME_ATTRIBUTES.map(
  (a) => `r.${a.column} AS ${a.column}`,
).join(",\n       ");
const FORBIDDEN_ATTR_CONTEXT_DISJUNCTION = FORBIDDEN_RUNTIME_ATTRIBUTES.map(
  (a) => `h.${a.column}`,
).join("\n                OR ");

/**
 * The forbidden predefined-role names as a SQL array literal. These come from
 * our own const list, never from request input, so inlining them is safe -- and
 * the query takes no parameters, which keeps it runnable through `psql` for the
 * live checks.
 */
const FORBIDDEN_MEMBERSHIP_ARRAY = `ARRAY[${FORBIDDEN_ROLE_MEMBERSHIPS.map(
  (m) => `'${m.role}'`,
).join(", ")}]::text[]`;

/**
 * One round trip. `pg_roles` is world-readable, `pg_database.datdba` and
 * `pg_class.relowner` likewise, so an unprivileged role can answer all of this
 * about itself -- no elevated grant is needed to run the check.
 *
 * One template, two subjects. The same facts are asked about the connection's
 * own role (`current_user` -- `main.ts`, on the connection that will serve
 * requests) and about the configured role by name (`$1` -- db-init's
 * pre-flight, asked as the owner before the runtime ever connects). Both
 * instantiations come from this single template so the two checks cannot
 * classify the same role differently: a second, hand-written safety query once
 * warned on attributes this one refuses (PR #1076), and near-identical checks
 * that give opposite answers are worse than either answer alone.
 */
function roleFactsSql(subject: "current_user" | "$1"): string {
  return `
WITH protected_owners AS (
  -- The roles that own an RLS-enabled public table. Collected once: the
  -- reachable-context arm below asks a pg_has_role question per owner per
  -- candidate role, and there are far fewer owners than tables.
  SELECT DISTINCT c.relowner AS oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public'
     AND c.relkind = 'r'
     AND c.relrowsecurity
),
forbidden_roles AS (
  -- The dangerous predefined roles that exist in this cluster. Filtering by name
  -- means a build where one is absent simply yields fewer rows, never an error.
  SELECT oid FROM pg_roles WHERE rolname = ANY(${FORBIDDEN_MEMBERSHIP_ARRAY})
)
SELECT r.rolname::text AS current_user_name,
       ${FORBIDDEN_ATTR_DIRECT_COLUMNS},
       (d.datdba = r.oid) AS owns_database,
       (SELECT count(*)
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relrowsecurity
           AND c.relowner = r.oid) AS owned_policied_tables,
       -- Every role CONTEXT this connection can enter, judged on what that
       -- context can do -- not just on what the runtime role directly holds.
       --
       -- RR4-001: asking pg_has_role(r, g, 'SET') and then testing whether g
       -- *directly* owns something misses a mode change partway along the chain.
       -- app --SET--> bridge --INHERIT--> owner gives SET=false and USAGE=false
       -- from app to owner, and bridge owns nothing itself, so both arms were
       -- silent -- while SET ROLE bridge lands in a context that inherits the
       -- owner and bypasses every policy. Measured: rls_active goes false and
       -- both tenants' rows appear.
       --
       -- So each reachable context is asked the ownership question in its OWN
       -- right, with USAGE (privileges, which inherit) rather than identity, and
       -- the forbidden-attribute question directly, because attributes do not
       -- inherit (RR5-001: a reachable REPLICATION context is unsafe once
       -- entered). Both pg_has_role calls are transitive, so a chain of any
       -- length in either mode is covered, and a role is its own SET/USAGE member
       -- so "owns it directly" needs no separate clause.
       (SELECT coalesce(array_agg(DISTINCT h.rolname::text), '{}'::text[])
          FROM pg_roles h
         WHERE h.oid <> r.oid
           AND pg_has_role(r.oid, h.oid, 'SET')
           AND (${FORBIDDEN_ATTR_CONTEXT_DISJUNCTION}
                OR pg_has_role(h.oid, d.datdba, 'USAGE')
                OR EXISTS (SELECT 1
                             FROM protected_owners po
                            WHERE pg_has_role(h.oid, po.oid, 'USAGE'))
                -- RR6-001: and whether the context reaches a forbidden
                -- predefined role. SET ROLE bridge --INHERIT--> server_program
                -- runs commands on the host; the bridge owns nothing and has no
                -- forbidden attribute, so only this USAGE question finds it.
                OR EXISTS (SELECT 1
                             FROM forbidden_roles fb
                            WHERE pg_has_role(h.oid, fb.oid, 'USAGE'))))
         AS exempt_reachable_contexts,
       -- USAGE from the runtime role itself: ownership is a privilege, and
       -- PostgreSQL's owner check walks inheritable memberships, so an inherited
       -- owner bypasses RLS with no SET ROLE at all (RR3-001). Reported
       -- separately from the contexts above because it is already true rather
       -- than one statement away, and because the remedy differs.
       (SELECT coalesce(array_agg(DISTINCT g.rolname::text), '{}'::text[])
          FROM pg_roles g
         WHERE g.oid <> r.oid
           AND pg_has_role(r.oid, g.oid, 'USAGE')
           AND (g.oid = d.datdba
                OR EXISTS (SELECT 1
                             FROM protected_owners po
                            WHERE po.oid = g.oid)))
         AS inherited_owner_roles,
       -- Forbidden predefined roles this role holds NOW by inheritance (RR6-001).
       -- USAGE, transitive, so a chain of INHERIT grants of any depth is caught;
       -- the parallel to inherited_owner_roles, for the capability that is active
       -- with no SET ROLE. Provisioning cannot strip these -- membership is a
       -- GRANT, not an attribute -- so this predicate is the only defence.
       (SELECT coalesce(array_agg(DISTINCT fb.rolname::text), '{}'::text[])
          FROM pg_roles fb
         WHERE fb.rolname = ANY(${FORBIDDEN_MEMBERSHIP_ARRAY})
           AND pg_has_role(r.oid, fb.oid, 'USAGE'))
         AS inherited_forbidden_roles
  FROM pg_roles r
  JOIN pg_database d ON d.datname = current_database()
 WHERE r.rolname = ${subject}
`.trim();
}

/**
 * The connection interrogating itself. Takes no parameters, which keeps it
 * runnable through `psql` for the live checks.
 */
export const RUNTIME_ROLE_FACTS_SQL = roleFactsSql("current_user");

/**
 * The same facts about a role named by parameter -- db-init's pre-flight of the
 * configured `DATABASE_APP_USER`, asked over the owner connection.
 */
export const NAMED_ROLE_FACTS_SQL = roleFactsSql("$1");

interface RawFactRow {
  current_user_name?: string;
  owns_database?: boolean;
  owned_policied_tables?: number | string;
  exempt_reachable_contexts?: string[] | string | null;
  inherited_owner_roles?: string[] | string | null;
  inherited_forbidden_roles?: string[] | string | null;
  // Plus one boolean per FORBIDDEN_RUNTIME_ATTRIBUTES column (rolsuper, ...).
  [column: string]: unknown;
}

/**
 * `text[]` arrives as a JS array from node-postgres and as the literal
 * `{a,b}` from anything that does not parse the OID -- and `name[]`, which
 * `array_agg(rolname)` produces without a cast, is one of those.
 *
 * This is not defensive noise. The first version of this check aggregated
 * `rolname` directly, so the field held the two-character string `"{}"`, whose
 * `.length` is 2: every `RLS_MODE=enforce` boot refused to start, naming a
 * membership violation that did not exist. The unit test could not see it
 * because its mock returned the array the code wanted rather than the value the
 * driver sends.
 */
function toRoleNames(value: string[] | string | null | undefined): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  const inner = value.trim().replace(/^\{|\}$/g, "");
  if (inner === "") return [];
  return inner
    .split(",")
    .map((name) => name.trim().replace(/^"|"$/g, ""))
    .filter((name) => name !== "");
}

/** Normalize what `DataSource.query` / `pg.Client.query` hand back. */
function firstRow(result: unknown): RawFactRow | undefined {
  if (Array.isArray(result)) return result[0] as RawFactRow | undefined;
  if (result && typeof result === "object" && "rows" in result) {
    const rows = (result as { rows?: unknown[] }).rows;
    return Array.isArray(rows)
      ? (rows[0] as RawFactRow | undefined)
      : undefined;
  }
  return undefined;
}

function factsFromRow(row: RawFactRow, currentUser: string): RuntimeRoleFacts {
  return {
    currentUser,
    directForbiddenAttributes: FORBIDDEN_RUNTIME_ATTRIBUTES.filter(
      (a) => !!row[a.column],
    ).map((a) => a.label),
    ownsDatabase: !!row.owns_database,
    ownedPoliciedTables: Number(row.owned_policied_tables ?? 0),
    exemptReachableContexts: toRoleNames(row.exempt_reachable_contexts),
    inheritedOwnerRoles: toRoleNames(row.inherited_owner_roles),
    inheritedForbiddenRoles: toRoleNames(row.inherited_forbidden_roles),
  };
}

export async function readRuntimeRoleFacts(
  querier: RuntimeRoleQuerier,
): Promise<RuntimeRoleFacts> {
  const row = firstRow(await querier.query(RUNTIME_ROLE_FACTS_SQL));
  if (!row?.current_user_name) {
    // `current_user` always exists, so an empty answer is a failed catalog
    // read, not a missing role.
    throw new Error(
      "RLS_MODE=enforce: could not read the runtime role's attributes from " +
        "pg_roles. Refusing to start rather than assume the role is safe.",
    );
  }
  return factsFromRow(row, row.current_user_name);
}

/**
 * The same facts, asked about a role by name rather than about the connection.
 * Returns null when no such role exists -- for the named question that is an
 * answer rather than a read failure, and the caller owns the refusal message.
 */
export async function readNamedRoleFacts(
  querier: RuntimeRoleQuerier,
  roleName: string,
): Promise<RuntimeRoleFacts | null> {
  const row = firstRow(await querier.query(NAMED_ROLE_FACTS_SQL, [roleName]));
  if (!row?.current_user_name) {
    return null;
  }
  return factsFromRow(row, row.current_user_name);
}

/**
 * Every reason `facts` disqualifies the connection from serving enforced
 * traffic, in the operator's words. Empty means the role is safe.
 *
 * Returns all of them rather than the first: an operator who fixed one attribute
 * and restarted should not discover the next one on the following restart.
 */
export function runtimeRoleViolations(
  facts: RuntimeRoleFacts,
  expectedRole: string,
): string[] {
  const violations: string[] = [];
  if (facts.currentUser !== expectedRole) {
    violations.push(
      `connected as "${facts.currentUser}" but DATABASE_APP_USER names ` +
        `"${expectedRole}"`,
    );
  }
  for (const label of facts.directForbiddenAttributes) {
    const attr = FORBIDDEN_RUNTIME_ATTRIBUTES.find((a) => a.label === label);
    violations.push(
      `role "${facts.currentUser}" holds ${label}, which ${attr?.why ?? "the unprivileged-role contract forbids"}`,
    );
  }
  if (facts.ownsDatabase) {
    violations.push(
      `role "${facts.currentUser}" owns this database; owner credentials must ` +
        "not serve ordinary requests",
    );
  }
  if (facts.ownedPoliciedTables > 0) {
    violations.push(
      `role "${facts.currentUser}" owns ${facts.ownedPoliciedTables} table(s) ` +
        "with RLS enabled, and a table's owner is exempt from its policies",
    );
  }
  if (facts.inheritedOwnerRoles.length > 0) {
    // First, because it is the only one that is already true rather than one
    // statement away, and because the fix is different.
    violations.push(
      `role "${facts.currentUser}" inherits the privileges of ${facts.inheritedOwnerRoles
        .map((r) => `"${r}"`)
        .join(
          ", ",
        )}, which own RLS-protected objects -- PostgreSQL treats an ` +
        "inherited owner as the owner, so policies are already inactive. Revoke " +
        "the membership or re-grant it WITH INHERIT FALSE",
    );
  }
  if (facts.inheritedForbiddenRoles.length > 0) {
    // Also already true, and also a REVOKE remedy -- but not an RLS matter at
    // all, so it names the specific capability each membership grants, drawn
    // from the same list the query is generated from (RR7-001: the denylist now
    // spans host-command, signalling, cluster-control and broad-data roles, so a
    // single "server-file or server-program" sentence would misdescribe most).
    const named = facts.inheritedForbiddenRoles
      .map((r) => {
        const m = FORBIDDEN_ROLE_MEMBERSHIPS.find((f) => f.role === r);
        return m ? `"${r}" (${m.why})` : `"${r}"`;
      })
      .join(", ");
    violations.push(
      `role "${facts.currentUser}" is a member of ${named}, a capability the ` +
        "unprivileged runtime role must not have. Revoke the membership",
    );
  }
  if (facts.exemptReachableContexts.length > 0) {
    // RR6-003: worded for every reason a reachable context lands here -- an RLS
    // exemption, a forbidden attribute like REPLICATION, or a forbidden
    // predefined-role membership. The old "policies do not apply" was false for
    // the last two, and a false diagnosis wastes the operator's investigation.
    violations.push(
      `role "${facts.currentUser}" can SET ROLE into ${facts.exemptReachableContexts
        .map((r) => `"${r}"`)
        .join(
          ", ",
        )}, a context with privileges forbidden to the runtime role -- an ` +
        "RLS exemption, a forbidden attribute, or a dangerous predefined-role " +
        "membership. Revoke the grant that makes it reachable",
    );
  }
  return violations;
}

export interface AssertRuntimeRoleOptions {
  mode: RlsMode;
  appUser: string | undefined;
}

/**
 * Verify the connection is fit to serve enforced traffic, or throw.
 *
 * Call it with the runtime's own connection -- the point is to interrogate the
 * session that will run requests, not a second one opened as somebody else.
 */
export async function assertRuntimeRoleSafe(
  querier: RuntimeRoleQuerier,
  { mode, appUser }: AssertRuntimeRoleOptions,
): Promise<RuntimeRoleFacts | null> {
  if (mode !== "enforce") return null;

  const expectedRole = appUser || DEFAULT_APP_USER;
  const facts = await readRuntimeRoleFacts(querier);
  throwOnViolations(runtimeRoleViolations(facts, expectedRole));
  return facts;
}

/** One refusal message for both asserts, so the wording cannot drift. */
function throwOnViolations(violations: string[]): void {
  if (violations.length === 0) return;
  // Generated from the forbidden list so it cannot omit an attribute the check
  // enforces -- RR6-003, where the hand-written sentence had dropped
  // NOREPLICATION and an operator following it would rebuild an unsafe role.
  const noAttributes = FORBIDDEN_RUNTIME_ATTRIBUTES.map(
    (a) => `NO${a.label}`,
  ).join(" ");
  throw new Error(
    "RLS_MODE=enforce requires an unprivileged, non-owner runtime role, " +
      `but ${violations.join("; ")}. ` +
      `Point DATABASE_APP_USER at a role created with ${noAttributes} that ` +
      "owns no application object and is a member of no privileged role, " +
      "or set RLS_MODE=shadow until it is provisioned.",
  );
}

/**
 * db-init's pre-flight of the same contract: the same facts template, the same
 * violation list, the same verdict as `assertRuntimeRoleSafe` -- asked as the
 * owner about the configured role by name, before the runtime ever connects as
 * it. Call it only under `RLS_MODE=enforce`; at `off`/`shadow` the runtime is
 * the owner by design and the configured role may be unused.
 *
 * The check on the serving connection (`main.ts`) stays authoritative -- it
 * sees the session as it actually is. This one exists to stop the boot in
 * db-init, where the operator reads the first error of a failed rollout,
 * instead of three processes later.
 */
export async function assertRuntimeRoleSafeByName(
  querier: RuntimeRoleQuerier,
  { appUser }: { appUser: string | undefined },
): Promise<void> {
  const expectedRole = appUser || DEFAULT_APP_USER;
  const facts = await readNamedRoleFacts(querier, expectedRole);
  if (!facts) {
    throw new Error(
      `RLS_MODE=enforce requires the runtime role '${expectedRole}' to exist, ` +
        "and it does not. Set DATABASE_APP_PASSWORD so it can be provisioned, " +
        "create it declaratively (CNPG spec.managed.roles), or use " +
        "RLS_MODE=shadow/off.",
    );
  }
  throwOnViolations(runtimeRoleViolations(facts, expectedRole));
}
