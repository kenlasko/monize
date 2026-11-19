import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyAccount } from "../model/kmy-raw";
import { parseKmyNumber, toDecimalString } from "../model/kmy-rational";
import { AccountTree, KMY_TYPE, isAssetOrLiability } from "./kmy-account-tree";

/** The warnings that are about one imported KMyMoney account (spec 5.2.1, 5.11). */
export function accountWarnings(
  account: KmyAccount,
  tree: AccountTree,
  definedCurrencies: ReadonlySet<string>,
  baseCurrency: string,
  warnings: MnyWarning[],
): void {
  const subject = account.name;
  if (account.type === KMY_TYPE.ASSET_LOAN) {
    warnings.push({ code: "assetLoanAsAsset", subject });
  }
  if (account.type === KMY_TYPE.CURRENCY) {
    warnings.push({ code: "currencyTradingAccount", subject });
  }
  const currency = account.currency?.trim();
  if (
    currency &&
    currency !== baseCurrency &&
    !definedCurrencies.has(currency)
  ) {
    warnings.push({ code: "unknownCurrency", subject, detail: currency });
  }
  const parent = tree.parentOf(account.id);
  const parentAccount = parent ? tree.byId.get(parent) : undefined;
  if (
    parentAccount &&
    !parentAccount.isStandard &&
    isAssetOrLiability(parentAccount.type)
  ) {
    warnings.push({ code: "accountHierarchyFlattened", subject });
  }
  if (account.number.trim() !== "" || (account.kvp.get("iban") ?? "") !== "") {
    warnings.push({ code: "accountNumbersNotImported", subject });
  }
  const reconciled = [
    ...account.reconciliations.map((entry) => entry.date),
    ...(account.lastReconciled ? [account.lastReconciled] : []),
  ].sort();
  if (reconciled.length > 0) {
    // m4: Monize keeps a row's reconciled state and date, not the account's
    // statement history; the latest statement date is named.
    warnings.push({
      code: "reconciliationHistoryNotImported",
      subject,
      detail: reconciled[reconciled.length - 1],
    });
  }
  if (account.hasOnlineBanking) {
    warnings.push({ code: "onlineBankingNotImported", subject });
  }
  if (account.type === KMY_TYPE.LOAN || account.type === KMY_TYPE.ASSET_LOAN) {
    const latest = latestInterestRate(account);
    if (latest !== null) {
      warnings.push({
        code: "loanInterestRateNotImported",
        subject,
        detail: latest,
      });
    }
  }
}

/** The value of the newest `ir-YYYY-MM-DD` KVP, as a 4-place decimal. */
function latestInterestRate(account: KmyAccount): string | null {
  const keys = [...account.kvp.keys()]
    .filter((key) => /^ir-\d{4}-\d{2}-\d{2}$/.test(key))
    .sort();
  const latest = keys[keys.length - 1];
  if (latest === undefined) {
    return null;
  }
  const parsed = parseKmyNumber(account.kvp.get(latest) ?? "");
  return parsed.kind === "value"
    ? toDecimalString(parsed.value, 4)
    : (account.kvp.get(latest) ?? null);
}
