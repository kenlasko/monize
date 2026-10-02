import { matchesAliasPattern } from "../payees/alias-match.util";
import type { PayeeAlias } from "../payees/entities/payee-alias.entity";
import type {
  ImportPreviewPayeeVia,
  ImportPreviewPayeeView,
} from "./import-preview.types";

/**
 * The alias pattern of `payeeId` that `text` matches, among `aliases`: what a
 * preview shows as "maps to this payee because of alias X". The payee lookups
 * (`findPayeeByAlias`) return the payee and not the pattern, so the pattern is
 * found among the user's aliases of that payee (`PayeesService.getAllAliases`)
 * with the same matcher, `matchesAliasPattern`, in the aliases' own order. Null
 * when none of them matches: "no information", never a made-up pattern.
 */
export function matchedAliasPattern(
  aliases: ReadonlyArray<Pick<PayeeAlias, "payeeId" | "alias">>,
  payeeId: string,
  text: string,
): string | null {
  const match = aliases.find(
    (alias) =>
      alias.payeeId === payeeId && matchesAliasPattern(text, alias.alias),
  );
  return match?.alias ?? null;
}

export interface PayeeResolutionReport {
  /** The source's counterparty text; null when it gave none. */
  original: string | null;
  /** The payee the transaction would carry after the rules; null for none. */
  name: string | null;
  /**
   * The existing payee the text resolved to before any rule ran, and how
   * (`name` or `alias`); null when none exists.
   */
  found: {
    payeeId: string;
    via: Extract<ImportPreviewPayeeVia, "name" | "alias">;
  } | null;
  /** The alias pattern that matched, when `found.via` is `alias` and it could be found. */
  aliasPattern: string | null;
  /**
   * Set when an import rule decided the payee (an existing one, a new one, or
   * none): the id it set, null for a payee to be created or cleared.
   */
  rule: { payeeId: string | null } | null;
}

/**
 * How a row's payee resolved, as the preview reports it. A rule outranks the
 * lookup, because it runs after it and its answer is what the transaction
 * carries; otherwise the existing payee that was found; otherwise a new payee
 * (the text names one) or none (the source gave no text). Pure.
 */
export function reportPayeeResolution(
  input: PayeeResolutionReport,
): ImportPreviewPayeeView {
  const { original, name } = input;
  if (input.rule !== null) {
    return {
      original,
      name,
      via: "rule",
      aliasPattern: null,
      payeeId: input.rule.payeeId,
    };
  }
  if (input.found !== null) {
    return {
      original,
      name,
      via: input.found.via,
      aliasPattern: input.found.via === "alias" ? input.aliasPattern : null,
      payeeId: input.found.payeeId,
    };
  }
  return {
    original,
    name,
    via: original === null ? "none" : "new",
    aliasPattern: null,
    payeeId: null,
  };
}
