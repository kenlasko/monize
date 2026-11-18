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

export class AliasLedger {
  private readonly nameByOwner = new Map<string, string>();
  private readonly ownerByLowerName = new Map<string, string>();
  private readonly literals = new Map<string, HeldAlias[]>();
  private readonly everyLiteral: HeldAlias[] = [];
  private readonly globs: HeldAlias[] = [];

  /** @param payees every payee that exists once the import has written its own. */
  constructor(payees: Iterable<AliasPayee>) {
    for (const payee of payees) {
      this.nameByOwner.set(payee.owner, payee.name);
      const lower = payee.name.trim().toLowerCase();
      if (!this.ownerByLowerName.has(lower)) {
        this.ownerByLowerName.set(lower, payee.owner);
      }
    }
  }

  /** Record an alias that exists (or is about to) on `owner`. */
  hold(alias: string, owner: string): void {
    const held = { alias, owner };
    if (alias.includes("*")) {
      this.globs.push(held);
      return;
    }
    const lower = alias.toLowerCase();
    this.literals.set(lower, [...(this.literals.get(lower) ?? []), held]);
    this.everyLiteral.push(held);
  }

  private describe(held: HeldAlias): string {
    return `${this.nameByOwner.get(held.owner) ?? held.owner}: ${held.alias}`;
  }

  private firstConflict(glob: string, owner: string): HeldAlias | null {
    if (!glob.includes("*")) {
      const hit = this.literals
        .get(glob.toLowerCase())
        ?.find((held) => held.owner !== owner);
      if (hit) {
        return hit;
      }
      return (
        this.globs.find(
          (held) => held.owner !== owner && aliasesConflict(glob, held.alias),
        ) ?? null
      );
    }
    return (
      [...this.everyLiteral, ...this.globs].find(
        (held) => held.owner !== owner && aliasesConflict(glob, held.alias),
      ) ?? null
    );
  }

  /** The first rule of the collision table that applies to `glob` for `owner`. */
  decide(glob: string, owner: string): AliasDecision {
    const conflicting = this.firstConflict(glob, owner);
    if (conflicting) {
      return { kind: "conflict", detail: this.describe(conflicting) };
    }
    if (!glob.includes("*")) {
      const nameOwner = this.ownerByLowerName.get(glob.toLowerCase());
      if (nameOwner !== undefined && nameOwner !== owner) {
        return {
          kind: "conflict",
          detail: `${this.nameByOwner.get(nameOwner) ?? nameOwner} (name)`,
        };
      }
      return { kind: "accept", overlap: null };
    }
    const overlapping = this.globs.find(
      (held) => held.owner !== owner && aliasesCanOverlap(glob, held.alias),
    );
    return {
      kind: "accept",
      overlap: overlapping ? this.describe(overlapping) : null,
    };
  }
}
