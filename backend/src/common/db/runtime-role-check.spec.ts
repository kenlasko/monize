import {
  FORBIDDEN_ROLE_MEMBERSHIPS,
  KNOWN_SAFE_PREDEFINED_ROLES,
  NAMED_ROLE_FACTS_SQL,
  RUNTIME_ROLE_FACTS_SQL,
  RuntimeRoleFacts,
  assertRuntimeRoleSafe,
  assertRuntimeRoleSafeByName,
  readNamedRoleFacts,
  readRuntimeRoleFacts,
  runtimeRoleViolations,
} from "./runtime-role-check";
import { APP_ROLE_ATTRIBUTES, APP_ROLE_UPSERT_SQL } from "./app-role";

const SAFE: RuntimeRoleFacts = {
  currentUser: "monize_app",
  directForbiddenAttributes: [],
  ownsDatabase: false,
  ownedPoliciedTables: 0,
  exemptReachableContexts: [],
  inheritedOwnerRoles: [],
  inheritedForbiddenRoles: [],
};

/** A querier returning one row, in the `DataSource.query` array shape. */
const arrayQuerier = (row: Record<string, unknown>) => ({
  query: jest.fn().mockResolvedValue([row]),
});

/** ...and in the `pg.Client.query` `{ rows }` shape. Both are used in-tree. */
const pgQuerier = (row: Record<string, unknown>) => ({
  query: jest.fn().mockResolvedValue({ rows: [row] }),
});

const SAFE_ROW = {
  current_user_name: "monize_app",
  rolsuper: false,
  rolbypassrls: false,
  rolreplication: false,
  rolcreaterole: false,
  rolcreatedb: false,
  owns_database: false,
  owned_policied_tables: "0",
  exempt_reachable_contexts: [],
  inherited_owner_roles: [],
  inherited_forbidden_roles: [],
};

describe("runtimeRoleViolations", () => {
  it("accepts an unprivileged non-owner role", () => {
    expect(runtimeRoleViolations(SAFE, "monize_app")).toEqual([]);
  });

  // Each of these is a role PostgreSQL exempts from every policy, which is what
  // made a successful RLS_MODE=enforce boot compatible with zero enforcement.
  it.each([
    ["a superuser", { directForbiddenAttributes: ["SUPERUSER"] }, /SUPERUSER/],
    [
      "a BYPASSRLS role",
      { directForbiddenAttributes: ["BYPASSRLS"] },
      /BYPASSRLS/,
    ],
    [
      "a REPLICATION role",
      { directForbiddenAttributes: ["REPLICATION"] },
      /REPLICATION/,
    ],
    [
      "a CREATEROLE role",
      { directForbiddenAttributes: ["CREATEROLE"] },
      /CREATEROLE/,
    ],
    [
      "a CREATEDB role",
      { directForbiddenAttributes: ["CREATEDB"] },
      /CREATEDB/,
    ],
    ["the database owner", { ownsDatabase: true }, /owns this database/],
    [
      "an owner of a policied table",
      { ownedPoliciedTables: 3 },
      /owns 3 table\(s\) with RLS enabled/,
    ],
  ])("rejects %s", (_label, override, expected) => {
    const violations = runtimeRoleViolations(
      { ...SAFE, ...(override as Partial<RuntimeRoleFacts>) },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(expected);
  });

  it("rejects a connection authenticated as a different role than configured", () => {
    // The operator asked for monize_app; the pool handed us the owner. Selecting
    // a username is not the same as connecting under it.
    const violations = runtimeRoleViolations(
      { ...SAFE, currentUser: "monize" },
      "monize_app",
    );

    expect(violations).toEqual([
      'connected as "monize" but DATABASE_APP_USER names "monize_app"',
    ]);
  });

  it("reports every reason at once", () => {
    // An operator who fixes one attribute and restarts should not discover the
    // next one on the following restart.
    const violations = runtimeRoleViolations(
      {
        currentUser: "monize",
        directForbiddenAttributes: ["SUPERUSER", "BYPASSRLS", "REPLICATION"],
        ownsDatabase: true,
        ownedPoliciedTables: 53,
        exemptReachableContexts: ["monize"],
        inheritedOwnerRoles: ["monize"],
        inheritedForbiddenRoles: ["pg_execute_server_program"],
      },
      "monize_app",
    );

    // wrong-role + 3 attributes + owns-db + owns-tables + inherited-owner +
    // inherited-forbidden + reachable.
    expect(violations).toHaveLength(9);
  });
});

describe("runtimeRoleViolations -- exempt role membership (DR-V2)", () => {
  it("refuses a role that can SET ROLE into an exempt one", () => {
    // The attribute check reads the LOGIN role only, so a role granted
    // membership in the owner (or in any BYPASSRLS role) passes every other
    // check while being one statement away from seeing every tenant.
    const violations = runtimeRoleViolations(
      { ...SAFE, exemptReachableContexts: ["monize", "rds_superuser"] },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"monize"');
    expect(violations[0]).toContain('"rds_superuser"');
    expect(violations[0]).toContain("SET ROLE");
  });

  it("refuses a runtime role that holds REPLICATION directly (RR5-001)", () => {
    // Not an RLS exemption, but the unprivileged-role contract forbids it: a
    // REPLICATION role can create a WAL-retaining slot and never advance it,
    // which is a database-wide availability failure. Provisioning strips it; the
    // verifier used not to read it, so an externally provisioned or drifted role
    // passed startup.
    const violations = runtimeRoleViolations(
      { ...SAFE, directForbiddenAttributes: ["REPLICATION"] },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("REPLICATION");
    expect(violations[0]).toMatch(/WAL|replication/i);
  });

  it("refuses a role that inherits a server-program membership (RR6-001)", () => {
    // OS command execution, not an RLS matter -- so the message names the
    // capability, not policies. Measured on a live server: a NOSUPERUSER member
    // of pg_execute_server_program ran COPY ... TO PROGRAM and wrote a host file.
    const violations = runtimeRoleViolations(
      { ...SAFE, inheritedForbiddenRoles: ["pg_execute_server_program"] },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"pg_execute_server_program"');
    // The message names the specific capability, drawn from the denylist entry.
    expect(violations[0]).toContain("COPY");
    expect(violations[0]).toContain("Revoke the membership");
    // Not an RLS diagnosis -- RR6-003 is precisely about not saying it is.
    expect(violations[0]).not.toContain("policies do not apply");
  });

  it("names the specific capability for each forbidden membership (RR7-001)", () => {
    // The denylist grew past server-file/server-program to signalling,
    // cluster-control and broad-data roles, so the message can no longer say
    // "server-file or server-program" -- it has to describe the role that is
    // actually granted, from the same list the SQL is generated from.
    const signal = runtimeRoleViolations(
      { ...SAFE, inheritedForbiddenRoles: ["pg_signal_backend"] },
      "monize_app",
    );
    expect(signal).toHaveLength(1);
    expect(signal[0]).toContain('"pg_signal_backend"');
    expect(signal[0]).toMatch(/terminate sessions/);
    expect(signal[0]).toContain("Revoke the membership");
    // It must not misdescribe a signalling role as server-file/program access.
    expect(signal[0]).not.toContain("server-program");
    expect(signal[0]).not.toContain("server-file");
  });

  it("gives a reachable context a truthful, non-RLS-specific reason (RR6-003)", () => {
    // A reachable context lands here for an RLS exemption, a forbidden attribute,
    // OR a forbidden membership. The old "policies do not apply" was false for
    // the last two and sent operators chasing an RLS problem that was not there.
    const violations = runtimeRoleViolations(
      { ...SAFE, exemptReachableContexts: ["repl_bridge"] },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("SET ROLE");
    expect(violations[0]).toContain("privileges forbidden to the runtime role");
    expect(violations[0]).not.toContain("policies do not apply");
  });

  it("accepts membership in an ordinary role, which grants no exemption", () => {
    // The query only reports memberships that are themselves exempt, so an
    // unrelated group grant is not a finding -- reporting it would train the
    // operator to ignore the message.
    expect(runtimeRoleViolations(SAFE, "monize_app")).toEqual([]);
  });

  it("asks the database about membership rather than assuming none", () => {
    // The first version of this check could not have answered the question at
    // all -- no role-membership catalog appeared in the query.
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("h.rolsuper");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("h.rolbypassrls");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("protected_owners");
  });

  it("refuses a role that inherits an owner's privileges, SET or not (RR3-001)", () => {
    // The defect this arm exists for, and the more urgent of the two: an
    // inherited owner bypasses RLS *now*, with no SET ROLE to detect. Measured on
    // a live server -- `GRANT owner TO app WITH INHERIT TRUE, SET FALSE` yields
    // SET=false, USAGE=true, row_security_active=false, and every tenant's rows.
    const violations = runtimeRoleViolations(
      { ...SAFE, inheritedOwnerRoles: ["monize_owner"] },
      "monize_app",
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('"monize_owner"');
    expect(violations[0]).toContain("inherits the privileges");
    // The remedy differs from a revoke, so the message has to say so.
    expect(violations[0]).toContain("INHERIT FALSE");
  });

  it("reports the inherited case first, because it is already true", () => {
    const violations = runtimeRoleViolations(
      {
        ...SAFE,
        inheritedOwnerRoles: ["monize_owner"],
        exemptReachableContexts: ["some_superuser"],
      },
      "monize_app",
    );

    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain("inherits the privileges");
    expect(violations[1]).toContain("SET ROLE");
  });

  it("never treats an attribute exemption as inheritable", () => {
    // `rolsuper` and `rolbypassrls` are attributes, and PostgreSQL does not
    // inherit them: verified on a live server -- a member of a BYPASSRLS role
    // with INHERIT TRUE still has row_security_active = true. Treating them as
    // inheritable would refuse to start on a harmless group membership, and an
    // operator who is told to revoke a harmless grant learns to ignore the check.
    const inheritedArm = RUNTIME_ROLE_FACTS_SQL.slice(
      RUNTIME_ROLE_FACTS_SQL.indexOf("AND pg_has_role(r.oid, g.oid, 'USAGE')"),
    );
    expect(inheritedArm).toContain("g.oid = d.datdba");
    expect(inheritedArm).toContain("protected_owners");
    expect(inheritedArm).not.toContain("rolsuper");
    expect(inheritedArm).not.toContain("rolbypassrls");
  });

  it("asks about forbidden predefined-role membership, direct and reachable (RR6-001)", () => {
    // Membership, not an attribute, so provisioning cannot strip it and the
    // parity guard is silent -- this predicate is the only defence. Both the
    // direct-inheritance column and the reachable-context arm consult it, with
    // USAGE (privileges inherit) exactly like the owner arms.
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("forbidden_roles");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("pg_execute_server_program");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("AS inherited_forbidden_roles");
    // The reachable arm asks the USAGE question of the context h, not of r.
    const reachableArm = RUNTIME_ROLE_FACTS_SQL.slice(
      RUNTIME_ROLE_FACTS_SQL.indexOf("AND pg_has_role(r.oid, h.oid, 'SET')"),
      RUNTIME_ROLE_FACTS_SQL.indexOf("AS exempt_reachable_contexts"),
    );
    expect(reachableArm).toContain("FROM forbidden_roles");
    expect(reachableArm).toContain("pg_has_role(h.oid, fb.oid, 'USAGE')");
  });

  it("asks both questions of the database, not one", () => {
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("AS exempt_reachable_contexts");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("AS inherited_owner_roles");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("'USAGE'");
  });

  it("judges a reachable context on what IT can reach, not on the catalog (RR4-001)", () => {
    // The composition the previous version missed. `app --SET--> bridge
    // --INHERIT--> owner` gives SET=false and USAGE=false from app to owner, and
    // the bridge owns nothing, so testing a candidate's DIRECT ownership found
    // nothing while `SET ROLE bridge` reached a context that bypasses every
    // policy. Measured on a live server: rls_active false, both tenants' rows.
    //
    // A source scan, because the fix is the SHAPE of the predicate: the ownership
    // question has to be asked with the candidate as the subject, not the runtime
    // role. `runtime-role.integration.spec.ts` proves the behaviour.
    const reachableArm = RUNTIME_ROLE_FACTS_SQL.slice(
      RUNTIME_ROLE_FACTS_SQL.indexOf("AND pg_has_role(r.oid, h.oid, 'SET')"),
      RUNTIME_ROLE_FACTS_SQL.indexOf("AS exempt_reachable_contexts"),
    );
    // The candidate is the subject of both ownership questions...
    expect(reachableArm).toContain("pg_has_role(h.oid, d.datdba, 'USAGE')");
    expect(reachableArm).toContain("pg_has_role(h.oid, po.oid, 'USAGE')");
    // ...and identity comparison is gone, because owning it directly is only one
    // of the two ways a context ends up with the owner's privileges.
    expect(reachableArm).not.toContain("h.oid = d.datdba");
    expect(reachableArm).not.toContain("po.oid = h.oid");
  });

  it("keeps the runtime role's own inherited ownership a direct question", () => {
    // The other arm stays identity-based on purpose: it answers "does THIS role
    // already have an owner's privileges", so the owner set is the thing being
    // matched, and widening it to reachability would merge two findings with two
    // different remedies.
    const inheritedArm = RUNTIME_ROLE_FACTS_SQL.slice(
      RUNTIME_ROLE_FACTS_SQL.indexOf("AND pg_has_role(r.oid, g.oid, 'USAGE')"),
    );
    expect(inheritedArm).toContain("g.oid = d.datdba");
    expect(inheritedArm).toContain("po.oid = g.oid");
  });

  it("asks about SET-ROLE reachability, not one hop of membership (DR-R1)", () => {
    // `pg_auth_members.member = r.oid` sees only roles granted DIRECTLY, so an
    // app -> platform_runtime -> owner chain passed startup whenever the
    // intermediate role was not itself exempt. `pg_has_role(..., 'SET')` is
    // transitive and evaluates each edge's SET option, which is the actual
    // question: can this role become that one.
    expect(RUNTIME_ROLE_FACTS_SQL).toContain(
      "pg_has_role(r.oid, h.oid, 'SET')",
    );
    // ...and the one-hop join is gone, not merely supplemented -- keeping it
    // would leave a second, weaker answer in the same query.
    expect(RUNTIME_ROLE_FACTS_SQL).not.toContain("m.member = r.oid");
    // A role is always "reachable" from itself; excluding it in both arms stops
    // the check reporting the runtime role as its own escalation path.
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("h.oid <> r.oid");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("g.oid <> r.oid");
  });
});

describe("predefined-role classification (DR-RR7-002)", () => {
  it("forbids pg_signal_backend membership", () => {
    // RR7-001: a signalling member can pg_terminate_backend other non-superuser
    // sessions across the cluster -- migrations, backups, other apps. It has no
    // forbidden attribute and owns nothing, so only the membership arm sees it.
    expect(FORBIDDEN_ROLE_MEMBERSHIPS.map((m) => m.role)).toContain(
      "pg_signal_backend",
    );
  });

  it("forbids the predefined roles PostgreSQL 17 and 18 added", () => {
    // pg_maintain (17) reaches every relation in the cluster, tables it does not
    // own included; pg_signal_autovacuum_worker (18) signals sessions it does not
    // own, as pg_signal_backend does. Left unclassified, the live catalog guard
    // in runtime-role.integration.spec.ts fails on PostgreSQL 18.
    const forbidden = FORBIDDEN_ROLE_MEMBERSHIPS.map((m) => m.role);
    expect(forbidden).toContain("pg_maintain");
    expect(forbidden).toContain("pg_signal_autovacuum_worker");
  });

  it("classifies every forbidden role with a capability-specific reason", () => {
    for (const { role, why } of FORBIDDEN_ROLE_MEMBERSHIPS) {
      expect(role).toMatch(/^pg_/);
      // The reason is what the operator reads and what the violation message
      // quotes, so an empty or placeholder one is a defect.
      expect(why.length).toBeGreaterThan(20);
    }
  });

  it("classifies each predefined role exactly once (no overlap, no omission gap)", () => {
    // The two lists are a partition: a role is forbidden or deliberately safe,
    // never both and never neither. The live integration guard proves the union
    // equals the catalog; here we prove the lists do not contradict each other.
    const forbidden = new Set<string>(
      FORBIDDEN_ROLE_MEMBERSHIPS.map((m) => m.role),
    );
    const safe = new Set<string>(KNOWN_SAFE_PREDEFINED_ROLES);
    for (const role of safe) {
      expect(forbidden.has(role)).toBe(false);
    }
    expect(forbidden.size).toBe(FORBIDDEN_ROLE_MEMBERSHIPS.length);
    expect(safe.size).toBe(KNOWN_SAFE_PREDEFINED_ROLES.length);
  });

  it("puts every forbidden role into the generated SQL array", () => {
    // The SQL array is generated from the list, so a new entry reaches both the
    // direct-inheritance and reachable-context arms with no second edit.
    for (const { role } of FORBIDDEN_ROLE_MEMBERSHIPS) {
      expect(RUNTIME_ROLE_FACTS_SQL).toContain(`'${role}'`);
    }
  });
});

describe("readRuntimeRoleFacts", () => {
  it("reads the array result shape TypeORM returns", async () => {
    const querier = arrayQuerier(SAFE_ROW);

    await expect(readRuntimeRoleFacts(querier)).resolves.toEqual(SAFE);
    expect(querier.query).toHaveBeenCalledWith(RUNTIME_ROLE_FACTS_SQL);
  });

  it("reads the array literal the driver actually sends", async () => {
    // The shape that broke enforce-mode startup. node-postgres parses text[] into
    // a JS array and leaves an unrecognized array OID as the literal string, so
    // `"{}"` -- length 2 -- was read as "one membership" and every boot refused.
    // A mock returning the array the code wants cannot fail this; the string is
    // what the driver sends.
    const empty = await readRuntimeRoleFacts(
      arrayQuerier({
        ...SAFE_ROW,
        exempt_reachable_contexts: "{}",
        inherited_owner_roles: "{}",
        inherited_forbidden_roles: "{}",
      }),
    );
    expect(empty.exemptReachableContexts).toEqual([]);
    expect(empty.inheritedOwnerRoles).toEqual([]);
    expect(empty.inheritedForbiddenRoles).toEqual([]);
    expect(runtimeRoleViolations(empty, "monize_app")).toEqual([]);

    const filled = await readRuntimeRoleFacts(
      arrayQuerier({
        ...SAFE_ROW,
        exempt_reachable_contexts: '{monize,"odd role"}',
      }),
    );
    expect(filled.exemptReachableContexts).toEqual(["monize", "odd role"]);
    expect(runtimeRoleViolations(filled, "monize_app")).toHaveLength(1);
  });

  it("asks the database for a text[], not the name[] array_agg defaults to", () => {
    // The cast is what makes the driver hand back an array at all. Without it the
    // normalizer above is the only thing standing between a fresh deployment and
    // a boot loop, and a guard that exists twice is cheaper than one that exists
    // where nobody looks.
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("g.rolname::text");
    expect(RUNTIME_ROLE_FACTS_SQL).toContain("'{}'::text[]");
  });

  it("treats a missing membership array as no memberships", async () => {
    const { exempt_reachable_contexts: _omitted, ...withoutMemberships } =
      SAFE_ROW;
    const facts = await readRuntimeRoleFacts(arrayQuerier(withoutMemberships));

    expect(facts.exemptReachableContexts).toEqual([]);
  });

  it("reads the { rows } result shape pg returns", async () => {
    await expect(readRuntimeRoleFacts(pgQuerier(SAFE_ROW))).resolves.toEqual(
      SAFE,
    );
  });

  it("coerces the bigint count Postgres returns as a string", async () => {
    const facts = await readRuntimeRoleFacts(
      arrayQuerier({ ...SAFE_ROW, owned_policied_tables: "7" }),
    );

    // A string "7" is truthy but `> 0` on a string is a comparison nobody
    // should have to reason about, so the boundary is crossed here, once.
    expect(facts.ownedPoliciedTables).toBe(7);
  });

  it("refuses to guess when pg_roles returns no row", async () => {
    await expect(
      readRuntimeRoleFacts({ query: jest.fn().mockResolvedValue([]) }),
    ).rejects.toThrow(/Refusing to start rather than assume the role is safe/);
  });
});

describe("assertRuntimeRoleSafe", () => {
  it("does not query the database at off or shadow", async () => {
    for (const mode of ["off", "shadow"] as const) {
      const querier = arrayQuerier(SAFE_ROW);

      await expect(
        assertRuntimeRoleSafe(querier, { mode, appUser: "monize_app" }),
      ).resolves.toBeNull();
      // Those modes connect as the owner deliberately; a check there would
      // fail every existing deployment.
      expect(querier.query).not.toHaveBeenCalled();
    }
  });

  it("returns the verified facts at enforce", async () => {
    await expect(
      assertRuntimeRoleSafe(arrayQuerier(SAFE_ROW), {
        mode: "enforce",
        appUser: "monize_app",
      }),
    ).resolves.toEqual(SAFE);
  });

  it("defaults the expected role name to monize_app", async () => {
    await expect(
      assertRuntimeRoleSafe(arrayQuerier(SAFE_ROW), {
        mode: "enforce",
        appUser: undefined,
      }),
    ).resolves.toEqual(SAFE);
  });

  it("honours an operator-chosen role name", async () => {
    await expect(
      assertRuntimeRoleSafe(arrayQuerier({ ...SAFE_ROW }), {
        mode: "enforce",
        appUser: "tenant_runtime",
      }),
    ).rejects.toThrow(/DATABASE_APP_USER names "tenant_runtime"/);
  });

  it("refuses to start on a BYPASSRLS role and says what to do", async () => {
    await expect(
      assertRuntimeRoleSafe(arrayQuerier({ ...SAFE_ROW, rolbypassrls: true }), {
        mode: "enforce",
        appUser: "monize_app",
      }),
    ).rejects.toThrow(
      /RLS_MODE=enforce requires an unprivileged, non-owner runtime role[\s\S]*NOBYPASSRLS/,
    );
  });

  it("refuses to start on the database owner", async () => {
    await expect(
      assertRuntimeRoleSafe(
        arrayQuerier({ ...SAFE_ROW, owns_database: true }),
        {
          mode: "enforce",
          appUser: "monize_app",
        },
      ),
    ).rejects.toThrow(/owns this database/);
  });
});

describe("the named-role facts query", () => {
  it("is the connection query with only the subject swapped", () => {
    // One template, two subjects. This is the guard against the defect the
    // PR #1076 review found: a second, hand-written role-safety query beside
    // this one warned on attributes this one refuses, so the pre-flight and
    // the runtime check gave opposite answers about the same role. Deriving
    // both from one template makes that state unrepresentable; this assertion
    // fails if either query grows an edit of its own.
    expect(NAMED_ROLE_FACTS_SQL).toBe(
      RUNTIME_ROLE_FACTS_SQL.replace(
        "r.rolname = current_user",
        "r.rolname = $1",
      ),
    );
  });

  it("asks about the named role, not the connection", () => {
    expect(NAMED_ROLE_FACTS_SQL).toContain("WHERE r.rolname = $1");
    expect(NAMED_ROLE_FACTS_SQL).not.toContain("r.rolname = current_user");
  });
});

describe("readNamedRoleFacts", () => {
  it("passes the role name as a parameter and reads the same facts", async () => {
    const querier = arrayQuerier(SAFE_ROW);

    await expect(readNamedRoleFacts(querier, "monize_app")).resolves.toEqual(
      SAFE,
    );
    expect(querier.query).toHaveBeenCalledWith(NAMED_ROLE_FACTS_SQL, [
      "monize_app",
    ]);
  });

  it("reads the { rows } result shape pg returns", async () => {
    await expect(
      readNamedRoleFacts(pgQuerier(SAFE_ROW), "monize_app"),
    ).resolves.toEqual(SAFE);
  });

  it("returns null when no such role exists", async () => {
    // For the named question a missing row is an answer ("no such role"), not
    // a failed catalog read -- the caller owns the refusal message.
    await expect(
      readNamedRoleFacts({ query: jest.fn().mockResolvedValue([]) }, "ghost"),
    ).resolves.toBeNull();
  });
});

describe("assertRuntimeRoleSafeByName", () => {
  it("accepts a safe role and defaults the name to monize_app", async () => {
    const querier = arrayQuerier(SAFE_ROW);

    await expect(
      assertRuntimeRoleSafeByName(querier, { appUser: undefined }),
    ).resolves.toBeUndefined();
    expect(querier.query).toHaveBeenCalledWith(NAMED_ROLE_FACTS_SQL, [
      "monize_app",
    ]);
  });

  it("refuses to start when the configured role does not exist", async () => {
    await expect(
      assertRuntimeRoleSafeByName(
        { query: jest.fn().mockResolvedValue([]) },
        { appUser: "monize_app" },
      ),
    ).rejects.toThrow(/requires the runtime role 'monize_app' to exist/);
  });

  it.each([
    ["a superuser", { rolsuper: true }],
    ["a BYPASSRLS role", { rolbypassrls: true }],
    ["a CREATEDB role", { rolcreatedb: true }],
    ["a CREATEROLE role", { rolcreaterole: true }],
    ["a REPLICATION role", { rolreplication: true }],
    ["the database owner", { owns_database: true }],
    ["an owner of policied tables", { owned_policied_tables: "2" }],
    ["an inherited owner", { inherited_owner_roles: ["monize"] }],
    [
      "a forbidden predefined-role member",
      { inherited_forbidden_roles: ["pg_execute_server_program"] },
    ],
    [
      "a role with an exempt reachable context",
      { exempt_reachable_contexts: ["monize"] },
    ],
  ])(
    "gives the same verdict as the runtime check on %s",
    async (_label, override) => {
      // The regression the PR #1076 review names: the pre-flight this replaces
      // classified CREATEDB/CREATEROLE/REPLICATION as warnings while the
      // runtime check refuses them, so db-init blessed a role that main.ts then
      // refused. Same facts, same violations function, same verdict -- both
      // must reject every one of these, and both must accept the safe row.
      const row = { ...SAFE_ROW, ...override };

      await expect(
        assertRuntimeRoleSafeByName(arrayQuerier(row), {
          appUser: "monize_app",
        }),
      ).rejects.toThrow(/RLS_MODE=enforce requires an unprivileged/);
      await expect(
        assertRuntimeRoleSafe(arrayQuerier(row), {
          mode: "enforce",
          appUser: "monize_app",
        }),
      ).rejects.toThrow(/RLS_MODE=enforce requires an unprivileged/);
    },
  );

  it("names every problem at once rather than one per restart", async () => {
    await expect(
      assertRuntimeRoleSafeByName(
        arrayQuerier({ ...SAFE_ROW, rolsuper: true, owns_database: true }),
        { appUser: "monize_app" },
      ),
    ).rejects.toThrow(/SUPERUSER[\s\S]*owns this database/);
  });
});

describe("APP_ROLE_UPSERT_SQL", () => {
  it("strips privileged attributes from an already existing role", () => {
    // The ALTER is the load-bearing half: a role provisioned out of band with
    // SUPERUSER or BYPASSRLS used to keep those attributes forever, because
    // provisioning only converged LOGIN PASSWORD.
    const alter = APP_ROLE_UPSERT_SQL.slice(
      APP_ROLE_UPSERT_SQL.indexOf("ALTER ROLE"),
    );

    for (const attribute of [
      "NOSUPERUSER",
      "NOCREATEDB",
      "NOCREATEROLE",
      "NOBYPASSRLS",
    ]) {
      expect(alter).toContain(attribute);
    }
  });

  it("creates the role with the same attribute set it converges to", () => {
    // Two different attribute lists would mean a freshly created role and a
    // converged one are not the same role.
    const create = APP_ROLE_UPSERT_SQL.slice(
      APP_ROLE_UPSERT_SQL.indexOf("CREATE ROLE"),
      APP_ROLE_UPSERT_SQL.indexOf("ELSE"),
    );

    expect(create).toContain(APP_ROLE_ATTRIBUTES);
    expect(
      APP_ROLE_UPSERT_SQL.slice(APP_ROLE_UPSERT_SQL.indexOf("ALTER ROLE")),
    ).toContain(APP_ROLE_ATTRIBUTES);
  });

  it("still passes the password as a quoted literal, never interpolated", () => {
    expect(APP_ROLE_UPSERT_SQL).toContain("PASSWORD %L");
    expect(APP_ROLE_UPSERT_SQL).not.toMatch(/PASSWORD\s+'/);
  });
});
