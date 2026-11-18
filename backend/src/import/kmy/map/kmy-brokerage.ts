import { KmyAccount } from "../model/kmy-raw";
import { AccountTree, KMY_TYPE } from "./kmy-account-tree";

/**
 * Every translation of `i18nc("Brokerage (suffix for account names)")` that
 * KMyMoney ships, read from `po/<language>/kmymoney.po` at commit
 * d3943e0de789efede86b56c4246e7f4338fcc664 (the commit the reference was
 * derived from), plus the English `Brokerage` first. KMyMoney names the cash
 * side of an investment account "<investment> (<suffix>)" in the language it
 * was created in, so a file carries any of these (spec 5.2.2).
 */
export const KMY_BROKERAGE_SUFFIXES: readonly string[] = [
  "Brokerage",
  "Verrechnung",
  "Courtage",
  "Corretaje",
  "Corretagem",
  "Corretaxe",
  "Intermediazione",
  "Makler",
  "Makléř",
  "Maklérstvo",
  "Børsmægler",
  "Kurtasje",
  "Kontantdepå",
  "Afsluitprovisie",
  "Maksunvälittäjä",
  "Vahendustehingute konto",
  "Artekaritza",
  "Valors",
  "Posredništvo",
  "Kurtado",
  "Bróicéireacht",
  "Brokeraj",
  "Komisyon",
  "Куртаж",
  "Брокерский счёт",
  "Делдал ақысы",
  "Μεσιτεία",
  "سمسرة",
  "ბროკერული ანგარიში",
  "ນາຍໜ້າ",
  "증권",
  "托管",
  "傭金",
];

/** Types a cash account may have (spec 5.2.2): Checkings, Savings, Cash, MoneyMarket, Asset. */
const CASH_TYPES: ReadonlySet<number> = new Set([
  KMY_TYPE.CHECKING,
  KMY_TYPE.SAVINGS,
  KMY_TYPE.CASH,
  KMY_TYPE.MONEY_MARKET,
  KMY_TYPE.ASSET,
]);

function eligible(account: KmyAccount | undefined): account is KmyAccount {
  return (
    account !== undefined && !account.isStandard && CASH_TYPES.has(account.type)
  );
}

/**
 * The cash account of one investment account `investment`: the account its
 * KVP `kmm-brokerage-account` names, else the first (by ordinal) account named
 * "<name> (<suffix>)" for a known suffix, compared case-insensitively. Accounts
 * in `claimed` belong to an earlier investment account and are skipped.
 */
export function findBrokerageAccount(
  investment: KmyAccount,
  accounts: readonly KmyAccount[],
  tree: AccountTree,
  claimed: ReadonlySet<string>,
): KmyAccount | null {
  const usable = (account: KmyAccount | undefined): account is KmyAccount =>
    eligible(account) &&
    account.id !== investment.id &&
    !claimed.has(account.id) &&
    tree.reachable(account.id);

  const named = investment.kvp.get("kmm-brokerage-account");
  if (named) {
    const byKvp = tree.byId.get(named);
    if (usable(byKvp)) {
      return byKvp;
    }
  }

  const wanted = new Set(
    KMY_BROKERAGE_SUFFIXES.map((suffix) =>
      `${investment.name.trim()} (${suffix})`.toLowerCase(),
    ),
  );
  return (
    accounts.find(
      (account) =>
        usable(account) && wanted.has(account.name.trim().toLowerCase()),
    ) ?? null
  );
}
