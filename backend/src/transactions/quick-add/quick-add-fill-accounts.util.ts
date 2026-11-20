/**
 * The accounts of a Quick Add entry (`docs/future-plans/quick-add.md`, the
 * fill table's account and toAccount rows).
 */
import type { AccountMention } from "./quick-add-names.util";
import type {
  QuickAddAccountRef,
  QuickAddCandidateAccount,
  QuickAddField,
  QuickAddSource,
} from "./quick-add.types";
import {
  QuickAddFillInput,
  QuickAddUsage,
  accountRef,
  field,
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
 * The default account: the context account, the payee's last account, the
 * reader's last created transaction's account, skipping `exclude` (the
 * other side of a transfer) so a transfer never defaults onto itself.
 */
function defaultAccount(
  input: QuickAddFillInput,
  exclude: string | null,
  collisions: readonly QuickAddCandidateAccount[],
): Picked {
  const historyAccount =
    input.history.recent.find((row) => input.accounts.has(row.accountId))
      ?.accountId ?? null;
  const chain: Array<[string | null, QuickAddSource]> = [
    [input.contextAccountId, "default"],
    [historyAccount, "inferred"],
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

/** Whether the accounts the text named make the entry a transfer. */
export function accountsImplyTransfer(
  mentions: readonly AccountMention[],
): boolean {
  return (
    mentions.length >= 2 ||
    mentions.some((m) => m.direction === "to" || m.direction === "from")
  );
}

export function resolveAccounts(
  input: QuickAddFillInput,
  isTransfer: boolean,
): { account: Picked; toAccount: Picked } {
  const { reading, pins, accountUsage } = input;
  const collisions = rankByUsage(reading.accountAlternatives, accountUsage);
  const none: Picked = {
    account: null,
    source: "none",
    ambiguous: false,
    alternatives: [],
  };
  if (!isTransfer) {
    const mention = reading.accounts[0];
    const account = pins.account
      ? pinned(pins.account)
      : mention
        ? fromMention(mention, accountUsage, collisions)
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
