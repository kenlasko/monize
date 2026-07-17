import { maskText, scaleMoney } from "./support-backup.util";

/**
 * Per-key obfuscation for JSONB columns. The column-level allowlist
 * (support-backup-rules.ts) is validated by the golden test against the live
 * schema, but that test cannot see inside a JSONB blob -- a new key added to
 * an existing JSON column would slip through. So every handler here is itself
 * an allowlist: it emits only the keys it explicitly classifies and drops the
 * rest. A unit test feeds each handler an object with a foreign key and
 * asserts it does not survive.
 */
export type JsonbHandlerName =
  | "transferRules"
  | "overrideSplits"
  | "lumpSums"
  | "reportFilters";

type JsonbHandler = (value: unknown, multiplier: number) => unknown;

/** `import_column_mappings.transfer_rules`: [{ type, pattern, accountName }]. */
const transferRules: JsonbHandler = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((rule) => {
    if (!isRecord(rule)) return {};
    return {
      type: rule.type,
      pattern: maskText(rule.pattern),
      accountName: maskText(rule.accountName),
    };
  });
};

/** `scheduled_transaction_overrides.splits`: [{ categoryId?, amount, memo? }]. */
const overrideSplits: JsonbHandler = (value, multiplier) => {
  if (!Array.isArray(value)) return [];
  return value.map((split) => {
    if (!isRecord(split)) return {};
    const out: Record<string, unknown> = {};
    if ("categoryId" in split) out.categoryId = split.categoryId; // remapped later
    if ("amount" in split) out.amount = scaleMoney(split.amount, multiplier);
    // memo is intentionally dropped
    return out;
  });
};

/** `loan_scenarios.lump_sums`: [{ date, amount, mode? }]. */
const lumpSums: JsonbHandler = (value, multiplier) => {
  if (!Array.isArray(value)) return [];
  return value.map((lump) => {
    if (!isRecord(lump)) return {};
    const out: Record<string, unknown> = {};
    if ("date" in lump) out.date = lump.date;
    if ("amount" in lump) out.amount = scaleMoney(lump.amount, multiplier);
    if ("mode" in lump) out.mode = lump.mode;
    return out;
  });
};

/** `custom_reports.filters`: { accountIds?, categoryIds?, payeeIds?, searchText? }. */
const reportFilters: JsonbHandler = (value) => {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  // Id arrays are opaque UUIDs the id remap rewrites; searchText is free text.
  for (const key of ["accountIds", "categoryIds", "payeeIds"] as const) {
    if (key in value) out[key] = value[key];
  }
  return out;
};

const HANDLERS: Record<JsonbHandlerName, JsonbHandler> = {
  transferRules,
  overrideSplits,
  lumpSums,
  reportFilters,
};

export function applyJsonbHandler(
  name: JsonbHandlerName,
  value: unknown,
  multiplier: number,
): unknown {
  return HANDLERS[name](value, multiplier);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
