import {
  aliasesCanOverlap,
  aliasesConflict,
} from "../../../payees/alias-overlap.util";

/**
 * Spec 5.5.1, collisions between different Monize payees. The KMyMoney mapper
 * applies this among the file's own payees (so the preview shows it) and the
 * payee-extras writer applies the same code at commit against the user's
 * existing aliases and payee names, which only the commit can see.
 *
 * `aliasesConflict` is exactly the refusal `PayeesService.createAlias` applies.
 * Literal-against-literal needs only equality, so an exact lookup answers it
 * and only a pair holding a `*` goes through the pattern functions: a file of
 * n aliases with w wildcard ones costs O(w x n) pair tests, not O(n x n).
 */

export interface AliasPayee {
  /** Identity of the Monize payee: its id, or its lowercased name in a preview. */
  readonly owner: string;
  /** The name the warning prints. */
  readonly name: string;
}

interface HeldAlias {
  readonly alias: string;
  readonly owner: string;
}

export type AliasDecision =
  | {
      readonly kind: "conflict";
      /** `<other payee>: <other alias>` or `<other payee> (name)`. */
      readonly detail: string;
    }
  | {
      readonly kind: "accept";
      /** `<other payee>: <other alias>` of an alias that can match the same text. */
      readonly overlap: string | null;
    };

/** What the mapper and the writer ask of the collision table. */
export interface AliasLedger {
  /** Record an alias that exists (or is about to) on `owner`. */
  hold(alias: string, owner: string): void;
  /** The first rule of the collision table that applies to `glob` for `owner`. */
  decide(glob: string, owner: string): AliasDecision;
}

/**
 * A fresh ledger per call (a closure, not process state): the mapper builds one
 * per parse and the writer one per import.
 *
 * @param payees every payee that exists once the import has written its own.
 */
export function createAliasLedger(payees: Iterable<AliasPayee>): AliasLedger {
  const nameByOwner = new Map<string, string>();
  const ownerByLowerName = new Map<string, string>();
  const literals = new Map<string, HeldAlias[]>();
  const everyLiteral: HeldAlias[] = [];
  const globs: HeldAlias[] = [];

  for (const payee of payees) {
    nameByOwner.set(payee.owner, payee.name);
    const lower = payee.name.trim().toLowerCase();
    if (!ownerByLowerName.has(lower)) {
      ownerByLowerName.set(lower, payee.owner);
    }
  }

  const describe = (held: HeldAlias): string =>
    `${nameByOwner.get(held.owner) ?? held.owner}: ${held.alias}`;

  const firstConflict = (glob: string, owner: string): HeldAlias | null => {
    if (!glob.includes("*")) {
      const hit = literals
        .get(glob.toLowerCase())
        ?.find((held) => held.owner !== owner);
      if (hit) {
        return hit;
      }
      return (
        globs.find(
          (held) => held.owner !== owner && aliasesConflict(glob, held.alias),
        ) ?? null
      );
    }
    return (
      [...everyLiteral, ...globs].find(
        (held) => held.owner !== owner && aliasesConflict(glob, held.alias),
      ) ?? null
    );
  };

  return {
    hold(alias, owner) {
      const held = { alias, owner };
      if (alias.includes("*")) {
        globs.push(held);
        return;
      }
      const lower = alias.toLowerCase();
      literals.set(lower, [...(literals.get(lower) ?? []), held]);
      everyLiteral.push(held);
    },

    decide(glob, owner) {
      const conflicting = firstConflict(glob, owner);
      if (conflicting) {
        return { kind: "conflict", detail: describe(conflicting) };
      }
      if (!glob.includes("*")) {
        const nameOwner = ownerByLowerName.get(glob.toLowerCase());
        if (nameOwner !== undefined && nameOwner !== owner) {
          return {
            kind: "conflict",
            detail: `${nameByOwner.get(nameOwner) ?? nameOwner} (name)`,
          };
        }
        return { kind: "accept", overlap: null };
      }
      const overlapping = globs.find(
        (held) => held.owner !== owner && aliasesCanOverlap(glob, held.alias),
      );
      return {
        kind: "accept",
        overlap: overlapping ? describe(overlapping) : null,
      };
    },
  };
}
