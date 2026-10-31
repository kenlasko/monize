import { returnedRows } from "./query-result";

/**
 * The SQL functions the application calls, declared once, with the migration
 * that creates each.
 *
 * A migration is the only thing that puts these in a database, and the migration
 * runner is a **separate process** from the server (`db-migrate.js`, then
 * `main.js` -- see `docker-entrypoint.sh`). So there is a real state where the
 * code that calls a function is running and the function is not there: a dev
 * container whose watcher rebuilt the source without restarting the container, a
 * deployment whose migration step was skipped or ran against a different
 * database, a restored volume older than the image on top of it.
 *
 * What that looked like before this file existed: a backup restore got as far as
 * `deleteAllUserData`, called `currency_code_in_use_globally` (migration 136),
 * and came back as
 *
 *     QueryFailedError: function currency_code_in_use_globally(character varying)
 *     does not exist
 *
 * behind a generic 500. The transaction rolled back, so nothing was lost -- but
 * the message names neither the cause nor the fix, and the same database would
 * have failed the same way on the next currency delete and the next export. A
 * schema the running code cannot use is not a per-request error; it is a
 * deployment that should never have started serving.
 *
 * Hence: one list, checked at boot, and the server refuses rather than
 * discovering it mid-write. This is the same posture as `runtime-role-check.ts`
 * -- ask the database what it actually is, and fail closed on a wrong answer.
 *
 * `required-db-functions.spec.ts` keeps the list honest in both directions: every
 * entry must be created by `database/schema.sql` **and** by the migration it
 * names, and every function `database/schema.sql` defines that `src/` mentions
 * must appear here. That second direction is the one that matters -- it means a
 * new SQL function called from TypeScript cannot be added without registering
 * it, which is precisely the omission that produced the failure above.
 */

/** Minimal query surface shared by `DataSource`, `pg.Client` and test doubles. */
export interface DbFunctionQuerier {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface RequiredDbFunction {
  /** Bare function name, as `src/` spells it in SQL. */
  name: string;
  /**
   * The identifier `to_regprocedure` resolves, schema-qualified with the
   * argument types. Qualified on purpose: an unqualified lookup answers for
   * whatever the connection's `search_path` happens to be, and the question
   * being asked is whether the object the application's SQL will reach exists.
   */
  identity: string;
  /** The migration that creates it, named in the failure message. */
  migration: string;
  /** What stops working without it, so the message says what broke. */
  usedBy: string;
}

/**
 * Ordered oldest-migration-first so a database several releases behind reports
 * the earliest gap first -- that is the one the operator has to fix, and the
 * later entries are usually consequences of the same skipped run.
 */
export const REQUIRED_DB_FUNCTIONS: readonly RequiredDbFunction[] = [
  {
    name: "app_current_user_id",
    identity: "public.app_current_user_id()",
    migration: "111_rls_helpers_and_trigger.sql",
    usedBy:
      "every row-level-security policy, and the delegation identity reads",
  },
  {
    name: "app_real_user_id",
    identity: "public.app_real_user_id()",
    migration: "111_rls_helpers_and_trigger.sql",
    usedBy:
      "the delegate policies, which distinguish acting-as from authenticated-as",
  },
  {
    name: "app_bypass_rls",
    identity: "public.app_bypass_rls()",
    migration: "111_rls_helpers_and_trigger.sql",
    usedBy: "the system-context escape hatch in withScopedDb",
  },
  {
    name: "currency_code_in_use_globally",
    identity: "public.currency_code_in_use_globally(varchar)",
    migration: "136_currency_global_liveness.sql",
    usedBy:
      "the backup restore's currency cleanup and the currency delete gate",
  },
  {
    name: "currency_codes_referenced_by_user_data",
    identity: "public.currency_codes_referenced_by_user_data(uuid)",
    migration: "137_currency_codes_referenced_by_user.sql",
    usedBy: "the currency delete gate",
  },
  {
    name: "currency_codes_referenced_by_user",
    identity: "public.currency_codes_referenced_by_user(uuid)",
    migration: "137_currency_codes_referenced_by_user.sql",
    usedBy:
      "the backup export, which must ship every currency definition the backup references",
  },
  {
    name: "shared_group_role",
    identity: "public.shared_group_role(uuid)",
    migration: "20261025184834_shared_expenses.sql",
    usedBy: "group membership policies",
  },
  {
    name: "shared_group_writable",
    identity: "public.shared_group_writable(uuid)",
    migration: "20261025184834_shared_expenses.sql",
    usedBy: "journal write policies",
  },
  {
    name: "shared_entry_writable",
    identity: "public.shared_entry_writable(uuid)",
    migration: "20261025184834_shared_expenses.sql",
    usedBy: "entry and document write policies",
  },
  {
    name: "shared_invitation_allows",
    identity: "public.shared_invitation_allows(uuid,uuid,text)",
    migration: "20261025184834_shared_expenses.sql",
    usedBy: "single-use invitation claims",
  },
  {
    name: "shared_validate_entry_allocations",
    identity: "public.shared_validate_entry_allocations()",
    migration: "20261025184834_shared_expenses.sql",
    usedBy: "deferred allocation conservation",
  },
  {
    name: "shared_document_group",
    identity: "public.shared_document_group(uuid,uuid)",
    migration: "20261025192210_shared_expense_documents.sql",
    usedBy: "shared document access and user erasure",
  },
  {
    name: "check_attachment_pair_parent",
    identity: "public.check_attachment_pair_parent()",
    migration: "20261025192210_shared_expense_documents.sql",
    usedBy: "receipt and original parent conservation",
  },
  {
    name: "shared_pending_notifications",
    identity: "public.shared_pending_notifications(uuid)",
    migration: "20261025202235_shared_expense_notifications.sql",
    usedBy: "bounded shared notification delivery",
  },
] as const;

/**
 * One statement, parameterised. `to_regprocedure` yields NULL for a function
 * that is not there instead of raising, so a single round trip answers for the
 * whole list and a missing one does not abort the check for the rest.
 */
export const MISSING_DB_FUNCTIONS_SQL = `
  SELECT ident FROM unnest($1::text[]) AS ident
   WHERE to_regprocedure(ident) IS NULL
`.trim();

/** The declared functions this database does not have, in declaration order. */
export async function missingDbFunctions(
  querier: DbFunctionQuerier,
  required: readonly RequiredDbFunction[] = REQUIRED_DB_FUNCTIONS,
): Promise<RequiredDbFunction[]> {
  if (required.length === 0) return [];
  const result = await querier.query(MISSING_DB_FUNCTIONS_SQL, [
    required.map((fn) => fn.identity),
  ]);
  const absent = new Set(
    rowsOf(result).map((row) => String((row as { ident: unknown }).ident)),
  );
  return required.filter((fn) => absent.has(fn.identity));
}

/**
 * The block printed before the process refuses to serve.
 *
 * Names the objects, the migrations that create them, and the one command that
 * fixes it -- an operator reading a crash loop needs the remedy in the same
 * screen as the symptom, not a stack trace pointing at whichever query happened
 * to reach the gap first.
 */
export function formatMissingDbFunctions(
  missing: readonly RequiredDbFunction[],
): string {
  const rule = "-".repeat(72);
  return [
    rule,
    "Database schema is behind this build; refusing to start.",
    "",
    "These SQL functions are called by code in this image and do not exist in",
    "the database it is connected to:",
    "",
    ...missing.flatMap((fn) => [
      `  ${fn.identity}`,
      `    created by: database/migrations/${fn.migration}`,
      `    needed for: ${fn.usedBy}`,
    ]),
    "",
    "The migration step (node dist/db-migrate.js) runs only at container start,",
    "so a process that reloaded its source without restarting the container --",
    "or a deployment whose migration step was skipped, or pointed at another",
    "database -- reaches this state. Restart the backend container so db-init",
    "and db-migrate run again, then check the log for the migrations applied.",
    "",
    "Serving anyway is not an option: the first request to reach one of these",
    "fails mid-transaction with a generic database error that names none of the",
    "above. A backup restore is the worst case -- it deletes before it reads.",
    rule,
  ].join("\n");
}

/**
 * Throw unless every declared function exists. Callers decide how to fail;
 * `main.ts` exits, `db-migrate` exits non-zero after its own DDL.
 */
export async function assertRequiredDbFunctions(
  querier: DbFunctionQuerier,
  required: readonly RequiredDbFunction[] = REQUIRED_DB_FUNCTIONS,
): Promise<void> {
  const missing = await missingDbFunctions(querier, required);
  if (missing.length > 0) {
    throw new Error(formatMissingDbFunctions(missing));
  }
}

/**
 * Rows out of either driver: TypeORM hands back the array (or the
 * `[rows, rowCount]` tuple `returnedRows` unwraps), `pg` hands back a result
 * object. One reader so a caller does not have to know which it passed.
 */
function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) {
    return returnedRows<Record<string, unknown>>(result);
  }
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}
