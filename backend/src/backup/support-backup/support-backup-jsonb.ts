import { maskText, scaleMoney } from "./support-backup.util";
import { isRecord } from "../../common/helpers/is-record";
import { FIAT_MONEY_DECIMALS } from "../../common/round.util";

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
  | "reportFilters"
  | "assetWeightings"
  | "gemMomentum";

/**
 * `decimals` is the money precision of the row's own currency, for a handler
 * that scales an amount (`FIAT_MONEY_DECIMALS` when the row has none of its own).
 */
type JsonbHandler = (
  value: unknown,
  multiplier: number,
  decimals: number,
) => unknown;

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
const overrideSplits: JsonbHandler = (value, multiplier, decimals) => {
  if (!Array.isArray(value)) return [];
  return value.map((split) => {
    if (!isRecord(split)) return {};
    const out: Record<string, unknown> = {};
    if ("categoryId" in split) out.categoryId = split.categoryId; // remapped later
    if ("amount" in split)
      out.amount = scaleMoney(split.amount, multiplier, decimals);
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

/**
 * `securities.asset_weightings`: [{ name, weight }]. Unlike country weightings
 * (a canonical public list, kept as-is) asset-class names are free text the
 * user types, so the name is masked and only the weight survives intact.
 */
const assetWeightings: JsonbHandler = (value) => {
  if (!Array.isArray(value)) return [];
  return value.map((slice) => {
    if (!isRecord(slice)) return {};
    const out: Record<string, unknown> = {};
    if ("name" in slice) out.name = maskText(slice.name);
    if ("weight" in slice) out.weight = slice.weight; // a share, not an amount
    return out;
  });
};

/**
 * `gem_strategy_signals.momentum`: trailing return in percent per strategy
 * role. The keys are the fixed role vocabulary and the values are returns, not
 * amounts -- nothing here is private, and a diagnosis of a wrong signal needs
 * the exact figures the decision was taken on. Keyed by an allowlist all the
 * same, so a role added later does not travel until it is classified.
 */
const gemMomentum: JsonbHandler = (value) => {
  if (!isRecord(value)) return {};
  const out: Record<string, unknown> = {};
  for (const role of [
    "US_EQUITY",
    "EX_US_EQUITY",
    "EM_EQUITY",
    "SAFE",
    "RISK_FREE",
  ] as const) {
    if (role in value) out[role] = value[role];
  }
  return out;
};

const HANDLERS: Record<JsonbHandlerName, JsonbHandler> = {
  transferRules,
  overrideSplits,
  lumpSums,
  reportFilters,
  assetWeightings,
  gemMomentum,
};

export function applyJsonbHandler(
  name: JsonbHandlerName,
  value: unknown,
  multiplier: number,
  decimals: number = FIAT_MONEY_DECIMALS,
): unknown {
  return HANDLERS[name](value, multiplier, decimals);
}
