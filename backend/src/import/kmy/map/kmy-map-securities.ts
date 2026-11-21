import {
  MappedSecurities,
  MappedSecurity,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyRawFile, KmySecurity } from "../model/kmy-raw";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";
import { KmyAccountMapping } from "./kmy-map-accounts";
import {
  MAX_SECURITY_SYMBOL_LENGTH,
  placeholderSymbol,
} from "../../mny/map/map-securities";
import type { SecurityType } from "../../../securities/security-enums";
import { KMY_MAX_NAME_LENGTH, clipName } from "./kmy-name-fixes";

/** Spec 5.8: the securities an imported holding references. */

const CURRENCY_CODE = /^[A-Z]{3}$/;

const TYPE_MAP: ReadonlyMap<number, SecurityType> = new Map([
  [0, "STOCK"],
  [1, "MUTUAL_FUND"],
  [2, "BOND"],
]);

export interface KmySecurityMapping {
  readonly securities: MappedSecurities;
  /** KMyMoney security id -> the mapped security (imported ones only). */
  readonly byId: ReadonlyMap<string, MappedSecurity>;
  /** KMyMoney security id -> the raw security, for the replay's `saf` and rounding. */
  readonly rawById: ReadonlyMap<string, KmySecurity>;
}

export interface MapKmySecuritiesInput {
  readonly raw: KmyRawFile;
  readonly tree: AccountTree;
  readonly mapping: KmyAccountMapping;
  readonly baseCurrency: string;
  readonly coinDecimals: ReadonlyMap<string, number>;
}

function uniqueSymbol(
  requested: string,
  taken: Set<string>,
): { symbol: string; collided: boolean } {
  const base = requested.slice(0, MAX_SECURITY_SYMBOL_LENGTH);
  if (!taken.has(base.toUpperCase())) {
    taken.add(base.toUpperCase());
    return { symbol: base, collided: false };
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate =
      base.slice(0, MAX_SECURITY_SYMBOL_LENGTH - suffix.length) + suffix;
    if (!taken.has(candidate.toUpperCase())) {
      taken.add(candidate.toUpperCase());
      return { symbol: candidate, collided: true };
    }
  }
}

export function mapKmySecurities(
  input: MapKmySecuritiesInput,
): KmySecurityMapping {
  const { raw, tree, mapping, baseCurrency, coinDecimals } = input;
  const warnings: MnyWarning[] = [];

  // Securities an imported holding (a stock account under an imported pair) names.
  const held = new Set<string>();
  for (const account of raw.accounts) {
    if (account.type !== KMY_TYPE.STOCK || !account.currency) {
      continue;
    }
    const parent = tree.nearestAncestor(
      account.id,
      (ancestor) => ancestor.type === KMY_TYPE.INVESTMENT,
    );
    if (parent && mapping.pairs.has(parent.id)) {
      held.add(account.currency);
    }
  }

  const taken = new Set<string>();
  const securities: MappedSecurity[] = [];
  const byId = new Map<string, MappedSecurity>();
  const byHandle = new Map<number, MappedSecurity>();

  for (const security of raw.securities) {
    if (!held.has(security.id)) {
      continue;
    }
    const name = security.name.trim();
    // A renamed name fits (`kmy-name-fixes.ts`); the fallbacks may not.
    const label = clipName(
      name || security.symbol.trim() || security.id,
      KMY_MAX_NAME_LENGTH,
    );
    const trading = security.tradingCurrency?.trim() ?? "";
    let currencyCode = trading;
    if (trading === "") {
      currencyCode = baseCurrency;
      warnings.push({
        code: "unknownCurrency",
        subject: label,
        detail: "trading-currency",
      });
    } else if (coinDecimals.has(trading)) {
      warnings.push({
        code: "securityNotImported",
        subject: label,
        detail: trading,
      });
      continue;
    } else if (!CURRENCY_CODE.test(trading)) {
      warnings.push({
        code: "unsupportedCurrencyCode",
        subject: label,
        detail: trading,
      });
      continue;
    }

    const moneySymbol = security.symbol.trim();
    const generated = moneySymbol === "";
    const requested = generated ? placeholderSymbol(label) : moneySymbol;
    const { symbol, collided } = uniqueSymbol(requested, taken);
    if (generated) {
      warnings.push({
        code: "generatedSecuritySymbol",
        subject: label,
        detail: symbol,
      });
    }
    if (collided) {
      warnings.push({
        code: "duplicateSecuritySymbol",
        subject: requested,
        detail: symbol,
      });
    }

    const mapped: MappedSecurity = {
      handle: security.ordinal,
      symbol,
      moneySymbol,
      name: label,
      currencyCode,
      securityType: TYPE_MAP.get(security.type) ?? null,
      skipPriceUpdates: generated,
    };
    securities.push(mapped);
    byId.set(security.id, mapped);
    byHandle.set(mapped.handle, mapped);
  }

  return {
    securities: {
      securities,
      byHandle,
      skipped: raw.securities.length - securities.length,
      warnings,
    },
    byId,
    rawById: new Map(raw.securities.map((security) => [security.id, security])),
  };
}
