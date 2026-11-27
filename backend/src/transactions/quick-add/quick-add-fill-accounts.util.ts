/**
 * The accounts of a Quick Add entry (`docs/future-plans/quick-add.md`, the
 * fill table's account and toAccount rows).
 */
import type { AccountMention } from "./quick-add-names.util";
import type {
  QuickAddAccountRef,
  QuickAddCandidateAccount,
  QuickAddField,
  QuickAddKind,
  QuickAddSource,
} from "./quick-add.types";
import {
  QuickAddFillInput,
  QuickAddUsage,
  accountRef,
  field,
  rankByRecentFrequency,
  rankByUsage,
  withoutIds,
} from "./quick-add-fill-shared.util";

export interface Picked {
  readonly account: QuickAddCandidateAccount | null;
  readonly source: QuickAddSource;
  readonly ambiguous: boolean;
  readonly alternatives: readonly QuickAddCandidateAccount[];
}

function fromMention(
  mention: AccountMention,
  usage: QuickAddUsage,
  collisions: readonly QuickAddCandidateAccount[],
): Picked {
  const ranked = rankByUsage(mention.candidates, usage);
  return {
    account: ranked[0],
    source: "typed",
    ambiguous: ranked.length > 1,
    alternatives: withoutIds(
      [...ranked.slice(1), ...collisions],
      [ranked[0].id],
    ),
  };
}

/**
 * The default account: the context account; else the account most of the
 * payee's last rows were on, the most recent winning a tie, with the payee's
 * other recent accounts offered next; else the reader's last created
 * transaction's account. `exclude` (the other side of a transfer) is
 * skipped, so a transfer never defaults onto itself.
 */
function defaultAccount(
  input: QuickAddFillInput,
  exclude: string | null,
  collisions: readonly QuickAddCandidateAccount[],
): Picked {
  const historyAccounts = rankByRecentFrequency(
    input.history.recent.map((row) => row.accountId),
    (id) => input.accounts.has(id),
  );
  const chain: Array<[string | null, QuickAddSource]> = [
    [input.contextAccountId, "default"],
    ...historyAccounts.map((id): [string, QuickAddSource] => [id, "inferred"]),
    [input.mostRecentAccountId, "default"],
  ];
  const usable = chain.filter(
    ([id]) => id !== null && id !== exclude && input.accounts.has(id),
  );
  const accounts = usable.map(([id]) => input.accounts.get(id as string)!);
  const first = accounts[0] ?? null;
  return {
    account: first,
    source: usable[0]?.[1] ?? "none",
    ambiguous: false,
    alternatives: withoutIds(
      [...accounts.slice(1), ...collisions],
      [first?.id],
    ),
  };
}

function pinned(account: QuickAddCandidateAccount): Picked {
  return { account, source: "pinned", ambiguous: false, alternatives: [] };
}

export function toField(picked: Picked): QuickAddField<QuickAddAccountRef> {
  return field(
    picked.account ? accountRef(picked.account) : null,
    picked.source,
    picked.alternatives.map(accountRef),
    picked.ambiguous,
  );
}

/**
 * The from and to mentions of a transfer: by connector, else in typed order.
 * One account named without a direction is the side no pin holds, and the
 * to side when neither is pinned (`transfer 500 savings`).
 */
function transferSides(
  mentions: readonly AccountMention[],
  pinned: { from: boolean; to: boolean },
): { from: AccountMention | null; to: AccountMention | null } {
  if (mentions.length === 0) return { from: null, to: null };
  if (mentions.length === 1) {
    const [only] = mentions;
    const isFrom =
      only.direction === "from" ||
      only.direction === "on" ||
      (only.direction === null && pinned.to && !pinned.from);
    return isFrom ? { from: only, to: null } : { from: null, to: only };
  }
  const [a, b] = mentions;
  if (a.direction === "to" && b.direction !== "to") return { from: b, to: a };
  if (b.direction === "from" && a.direction !== "from") {
    return { from: b, to: a };
  }
  return { from: a, to: b };
}

/**
 * Whether the accounts the text named make the entry a transfer, given the
 * payment or deposit the text typed, if any. A typed kind never outranks the
 * directions (`docs/future-plans/quick-add.md`, "Filling what was not
 * typed"): two named accounts are a transfer; so is a `to` account on a
 * payment (`paid 500 to visa` moves money into Visa) and a `from` account on
 * a deposit (`received 100 from savings` moves it out of Savings). A `from`
 * account on a payment and a `to` account on a deposit are the entry's own
 * account (`spent 20 from savings`, `received 100 to savings`).
 */
export function accountsImplyTransfer(
  mentions: readonly AccountMention[],
  typed: Exclude<QuickAddKind, "transfer"> | null = null,
): boolean {
  if (mentions.length >= 2) return true;
  return mentions.some((m) =>
    typed === "payment"
      ? m.direction === "to"
      : typed === "deposit"
        ? m.direction === "from"
        : m.direction === "to" || m.direction === "from",
  );
}

/**
 * The account of a payment or deposit the text named: the first mention whose
 * direction suits the kind (a payment is made from an account, a deposit made
 * to one). Two named accounts on a pinned payment or deposit are ambiguous,
 * the other offered first among the alternatives.
 */
function entryAccount(
  mentions: readonly AccountMention[],
  kind: QuickAddKind,
  usage: QuickAddUsage,
  collisions: readonly QuickAddCandidateAccount[],
): Picked {
  const contrary = (m: AccountMention) =>
    (kind === "payment" && m.direction === "to") ||
    (kind === "deposit" && m.direction === "from");
  const ordered = [
    ...mentions.filter((m) => !contrary(m)),
    ...mentions.filter(contrary),
  ];
  const others = ordered
    .slice(1)
    .flatMap((m) => rankByUsage(m.candidates, usage));
  const picked = fromMention(ordered[0], usage, [...others, ...collisions]);
  return { ...picked, ambiguous: picked.ambiguous || mentions.length > 1 };
}

export function resolveAccounts(
  input: QuickAddFillInput,
  kind: QuickAddKind,
): { account: Picked; toAccount: Picked } {
  const isTransfer = kind === "transfer";
  const { reading, pins, accountUsage } = input;
  const collisions = rankByUsage(reading.accountAlternatives, accountUsage);
  const none: Picked = {
    account: null,
    source: "none",
    ambiguous: false,
    alternatives: [],
  };
  if (!isTransfer) {
    const account = pins.account
      ? pinned(pins.account)
      : reading.accounts.length > 0
        ? entryAccount(reading.accounts, kind, accountUsage, collisions)
        : defaultAccount(input, null, collisions);
    return { account, toAccount: none };
  }
  const sides = transferSides(reading.accounts, {
    from: !!pins.account,
    to: !!pins.toAccount,
  });
  const typedFrom = sides.from
    ? fromMention(sides.from, accountUsage, collisions)
    : null;
  const typedTo = sides.to ? fromMention(sides.to, accountUsage, []) : null;
  const toFixed = pins.toAccount ? pinned(pins.toAccount) : typedTo;
  const account = pins.account
    ? pinned(pins.account)
    : (typedFrom ??
      defaultAccount(input, toFixed?.account?.id ?? null, collisions));
  const toAccount =
    toFixed ??
    (sides.from
      ? {
          ...defaultAccount(input, account.account?.id ?? null, []),
          source: "default" as const,
        }
      : none);
  return {
    account,
    toAccount:
      toAccount.account === null ? { ...toAccount, source: "none" } : toAccount,
  };
}
