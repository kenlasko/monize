import { Logger } from "@nestjs/common";
import { DEFAULT_APP_USER } from "./rls-config";

/**
 * Provisioning of the unprivileged `monize_app` runtime role and its DML grants.
 *
 * This lives in db-init (run as the DB owner on every startup), NOT in a
 * migration: a migration that referenced the role (`GRANT ... TO monize_app`,
 * `ALTER DEFAULT PRIVILEGES FOR ROLE ...`) would run unconditionally at startup
 * and crash-loop any deployment where the role does not yet exist. Keeping all
 * role/grant SQL here is what lets existing deployments upgrade with zero new
 * env vars and zero behavior change. See the RLS design doc, Phase 1.
 *
 * The SQL is exported (not just executed inline) so the integration harness (T1)
 * can apply the exact same grants without duplicating them.
 */

/** Minimal query surface shared by `pg.Client` and test doubles. */
export interface SqlClient {
  query(
    text: string,
    params?: unknown[],
  ): Promise<{ rows?: unknown[] } | unknown>;
}

/** Minimal logger surface (matches NestJS `Logger` and any test double). */
export interface RoleProvisionLogger {
  log(message: string): void;
  warn(message: string): void;
}

/**
 * Session GUC that carries the operator-chosen role name into the DO blocks.
 * A dotted (namespaced) custom GUC can be set at runtime without prior
 * definition, and `format('%I', ...)` quotes it as an identifier so a hostile
 * role name cannot inject SQL.
 */
export const APP_ROLE_NAME_GUC = "monize.app_role";

/**
 * Session GUC that carries the password into the DO block. The password reaches
 * SQL only via a parameterized `set_config` (never string interpolation), then
 * `format('%L', ...)` quotes it as a literal inside the CREATE/ALTER ROLE.
 */
export const APP_ROLE_PASSWORD_GUC = "monize.app_password";

/**
 * The attribute set that makes the role unprivileged, spelled out on both the
 * CREATE and the ALTER.
 *
 * The ALTER is the load-bearing half. Provisioning used to converge only
 * `LOGIN PASSWORD`, so a role that already existed kept whatever attributes it
 * was created with -- `SUPERUSER` or `BYPASSRLS` among them -- and PostgreSQL
 * exempts both from every policy. `ALTER ROLE` is not additive, so naming the
 * NO-forms here actually strips them.
 *
 * This still cannot be the only defence: the deployment may provision the role
 * declaratively (CNPG `managed.roles`) where this SQL never runs, the ALTER can
 * fail with `insufficient_privilege` and degrade to a warning, and an attribute
 * granted after startup is invisible to it. `runtime-role-check.ts` asks the
 * database what the connection actually is, and refuses to serve traffic on a
 * wrong answer.
 */
/**
 * `NOINHERIT` is defence in depth for RR3-001, not the fix.
 *
 * PostgreSQL decides table ownership with `has_privs_of_role`, which walks
 * *inheritable* memberships -- so a role that inherits the owner's privileges is
 * an owner for the RLS check and bypasses every policy without ever issuing
 * `SET ROLE`. `NOINHERIT` makes that the role's default, which helps.
 *
 * It cannot be the whole answer, for three reasons that all apply here: the
 * deployment may provision the role declaratively (CNPG `managed.roles`) where
 * this SQL never runs; PostgreSQL 16 stores inheritance on each membership grant,
 * so `GRANT owner TO app WITH INHERIT TRUE` overrides the role default; and the
 * `ALTER` below degrades to a warning without `CREATEROLE`. The startup check is
 * what actually refuses to serve -- this only narrows the default.
 */
export const APP_ROLE_ATTRIBUTES =
  "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT";

/**
 * The `NO<x>` half of `APP_ROLE_ATTRIBUTES`, i.e. the attributes an operator must
 * strip when provisioning declaratively. Derived from the one attribute string so
 * the insufficient-privilege warning below cannot drift behind the contract the
 * runtime verifier enforces (RR7-002: the warning hand-listed four of these and
 * silently dropped `NOREPLICATION` and `NOINHERIT`, so an operator who followed it
 * into `managed.roles` rebuilt a role that later failed enforce-mode startup).
 * `app-role.spec.ts` asserts every one of these appears in the warning text.
 */
export const APP_ROLE_FORBIDDEN_ATTRIBUTE_TOKENS = APP_ROLE_ATTRIBUTES.split(
  /\s+/,
).filter((token) => token.startsWith("NO"));

/**
 * Create the role if absent, else converge its attributes and rotate its
 * password. Idempotent and re-applied on every startup so rotating
 * `DATABASE_APP_PASSWORD` and restarting is sufficient. On managed Postgres
 * (CNPG) where the owner lacks `CREATEROLE`, the CREATE/ALTER raises
 * `insufficient_privilege` (42501); we swallow it with a warning and let the
 * role be provisioned declaratively via the CNPG `Cluster` spec
 * (`managed.roles`).
 */
export const APP_ROLE_UPSERT_SQL = `
DO $$
DECLARE
  role_name text := current_setting('${APP_ROLE_NAME_GUC}');
  role_pw   text := current_setting('${APP_ROLE_PASSWORD_GUC}');
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('CREATE ROLE %I ${APP_ROLE_ATTRIBUTES} PASSWORD %L', role_name, role_pw);
  ELSE
    EXECUTE format('ALTER ROLE %I ${APP_ROLE_ATTRIBUTES} PASSWORD %L', role_name, role_pw);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Insufficient privilege to create/alter role %; provision it declaratively via CNPG managed.roles (spec.managed.roles) with ${APP_ROLE_FORBIDDEN_ATTRIBUTE_TOKENS.join(" ")}.', role_name;
END $$;
`.trim();

/**
 * Session defaults for the runtime role, applied whenever the role exists.
 *
 * `jit = off`: every table the register joins carries an RLS policy whose
 * delegate-read arm adds subplans, which lifts a register count over an
 * 800-row account to a planner cost near 720k -- past the 500k JIT inline and
 * optimise thresholds -- so a server built with LLVM compiled ~2,700 functions
 * on every call: ~15 s of CPU for a query that executes in ~25 ms. These are
 * short OLTP queries that JIT never repays. Images without LLVM (CNPG
 * `-minimal`) never compile, so there it changes nothing.
 *
 * A separate block from the grants on purpose: an `insufficient_privilege`
 * here (no CREATEROLE / ADMIN on the role, as under CNPG `managed.roles`) must
 * not roll back the grants with it. A role default reaches new sessions only,
 * so it takes effect for connections opened after this runs.
 */
export const APP_ROLE_SETTINGS_SQL = `
DO $$
DECLARE
  role_name text := current_setting('${APP_ROLE_NAME_GUC}');
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('ALTER ROLE %I SET jit = off', role_name);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Insufficient privilege to set session defaults on role %; set jit = off on it manually or via the DB owner.', role_name;
END $$;
`.trim();

/**
 * Apply DML grants + default privileges whenever the role exists (however it
 * was provisioned). No `FOR ROLE` clause: `ALTER DEFAULT PRIVILEGES` then
 * applies to the current role -- the actual owner, whatever its operator-chosen
 * name. Re-applied every startup so a grant revoked out-of-band is restored and
 * a role provisioned late (CNPG, manual DBA) converges on the next restart.
 * Insufficient-privilege failures degrade to a warning so an `off`/`shadow`
 * deployment (where the role is unused) still boots.
 */
export const APP_ROLE_GRANTS_SQL = `
DO $$
DECLARE
  role_name text := current_setting('${APP_ROLE_NAME_GUC}');
  infra_table text;
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', role_name);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', role_name);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', role_name);

    -- Then take back what the blanket grant should never have included.
    --
    -- The grant above is deliberately "all tables": a new user-owned table has
    -- to be reachable the moment a migration creates it, and an allowlist that
    -- has to be edited per table would be forgotten, leaving the feature broken
    -- in enforce mode only. But "all tables" also hands the runtime role write
    -- access to the migration ledger, which no request has any reason to touch
    -- and which no RLS policy protects -- it is one of the four documented
    -- exemptions. A mistaken raw query or an application SQL injection could
    -- rewrite it, and db-migrate reads it to decide what to replay: a forged row
    -- silently skips a migration, a deleted one replays a migration on top of
    -- itself. Revoking write while keeping SELECT is a strict narrowing (task
    -- DR-02); nothing at runtime writes it.
    FOR infra_table IN SELECT unnest(ARRAY['schema_migrations']) LOOP
      IF EXISTS (
        SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = infra_table
      ) THEN
        EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM %I', infra_table, role_name);
      END IF;
    END LOOP;

    -- currency_code_in_use_globally (migration 136) is SECURITY DEFINER and
    -- revokes EXECUTE from PUBLIC in the same file -- the implicit grant every
    -- other function keeps. Nothing re-grants it to the runtime role without
    -- this, so RLS_MODE=enforce gets "permission denied for function" the
    -- first time CurrenciesService.remove asks whether a code is still live
    -- anywhere. Guarded by to_regprocedure so a boot before migration 136 has
    -- run (or a downgrade) does not fail on a missing function.
    IF to_regprocedure('public.currency_code_in_use_globally(varchar)') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.currency_code_in_use_globally(varchar) TO %I', role_name);
    END IF;
    -- Its sibling currency_code_referenced_by_data (the kind-change gate) has
    -- the same shape and needs the same grant.
    IF to_regprocedure('public.currency_code_referenced_by_data(varchar)') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.currency_code_referenced_by_data(varchar) TO %I', role_name);
    END IF;
    -- currency_min_decimal_places_in_use (the decimal-places lowering gate) is
    -- SECURITY DEFINER with EXECUTE revoked from PUBLIC too, and needs the same
    -- grant under the same guard.
    IF to_regprocedure('public.currency_min_decimal_places_in_use(varchar)') IS NOT NULL THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION public.currency_min_decimal_places_in_use(varchar) TO %I', role_name);
    END IF;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE WARNING 'Insufficient privilege to grant DML to role %; grant it manually or via the DB owner.', role_name;
END $$;
`.trim();

/**
 * Tables the runtime role may read but never write: infrastructure with no RLS
 * policy, where the blanket grant is the only thing standing between a mistaken
 * query and a corrupted invariant. Exported so the integration harness can
 * assert the revoke actually took (`app-role.spec.ts` asserts the SQL; only a
 * live database can assert the privilege).
 */
export const RUNTIME_READ_ONLY_TABLES = ["schema_migrations"] as const;

export interface ProvisionAppRoleOptions {
  appUser: string | undefined;
  appPassword: string | undefined;
  logger?: RoleProvisionLogger;
}

/**
 * Apply the grants alone, without touching the role or its password.
 *
 * Called twice per startup: by `db-init` (inside `provisionAppRole`) and again
 * by `db-migrate` after its DDL. On a first boot the second call is the one
 * that takes effect: db-init's grants run before `schema.sql` has created
 * anything, so the write-revoke on `schema_migrations` finds no table and is
 * skipped -- and the default privileges db-init sets then hand the runtime role
 * INSERT/UPDATE/DELETE on the ledger the moment it is created. Re-running after
 * migrations is what takes those writes back. The same pass is what would cover
 * an object a migration creates in the boot that first ships it, once this SQL
 * carries a grant for it -- today it carries none beyond the blanket
 * table/sequence grants, which `ALTER DEFAULT PRIVILEGES` already extends to
 * new objects.
 *
 * Idempotent and never fatal: a privilege shortfall degrades to a warning, as
 * everywhere else in this file.
 */
export async function applyAppRoleGrants(
  client: SqlClient,
  { appUser }: { appUser: string | undefined },
): Promise<void> {
  const roleName = appUser || DEFAULT_APP_USER;
  await client.query("SELECT set_config($1, $2, false)", [
    APP_ROLE_NAME_GUC,
    roleName,
  ]);
  await client.query(APP_ROLE_GRANTS_SQL);
}

/**
 * Provision (or converge) the runtime role and its grants. Safe to call on
 * every startup and before the "tables already exist" early return in db-init,
 * so both initial creation and password rotation run on an already-initialized
 * DB. Never throws on a missing password or a privilege shortfall -- those
 * degrade to warnings so a plain upgrade at `RLS_MODE=off` is unaffected.
 */
export async function provisionAppRole(
  client: SqlClient,
  {
    appUser,
    appPassword,
    logger = new Logger("AppRole"),
  }: ProvisionAppRoleOptions,
): Promise<void> {
  const roleName = appUser || DEFAULT_APP_USER;

  // Carry the role name into the DO blocks as a session GUC (parameterized).
  await client.query("SELECT set_config($1, $2, false)", [
    APP_ROLE_NAME_GUC,
    roleName,
  ]);

  if (appPassword) {
    // Parameterized: the password never appears in top-level SQL text.
    await client.query("SELECT set_config($1, $2, false)", [
      APP_ROLE_PASSWORD_GUC,
      appPassword,
    ]);
    await client.query(APP_ROLE_UPSERT_SQL);
    logger.log(
      `Ensured runtime role '${roleName}' (created or password rotated).`,
    );
  } else {
    logger.warn(
      `DATABASE_APP_PASSWORD not set; skipping creation of runtime role '${roleName}'. ` +
        "Grants will still be applied if the role already exists (e.g. via CNPG managed.roles).",
    );
  }

  // Session defaults and grants run whenever the role exists, regardless of
  // how it was provisioned. db-migrate re-applies the grants after its DDL --
  // see applyAppRoleGrants.
  await client.query(APP_ROLE_SETTINGS_SQL);
  await client.query(APP_ROLE_GRANTS_SQL);
}
