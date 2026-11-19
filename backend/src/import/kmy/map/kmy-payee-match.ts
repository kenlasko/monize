import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyPayee } from "../model/kmy-raw";

/**
 * Spec 5.5.1: a KMyMoney payee matching rule as Monize alias globs.
 *
 * KMyMoney searches each key as a PCRE2 regular expression in an imported
 * payee text; a Monize alias is a glob (`*` only) over the whole text, case
 * insensitive. A key becomes an alias only when the two agree on every text:
 * the subset grammar below, then checks 1 to 9. The key is tokenized by hand
 * and never compiled: no RegExp is ever built from file text.
 *
 * Pure. The collision rules between payees are in `payee-alias-collision`.
 */

export type NotImportedReason =
  | "untranslatable"
  | "literalStar"
  | "matchesEverything"
  | "angleBracket"
  | "edgeWhitespace"
  | "tooLong"
  | "caseFolding";

/** The most characters a Monize alias holds (`payee_aliases.alias VARCHAR(255)`). */
export const MAX_ALIAS_LENGTH = 255;

export interface AliasCandidate {
  /** The Monize glob. */
  readonly glob: string;
  /** The key as written, for warning subjects. */
  readonly key: string;
}

export interface PayeeMatchTranslation {
  readonly candidates: readonly AliasCandidate[];
  readonly warnings: readonly MnyWarning[];
}

interface Translated {
  readonly glob: string;
  /** The key holds an escaped `*`: a Monize glob has no escape for it. */
  readonly literalStar: boolean;
}

function collapseStars(glob: string): string {
  return glob.replace(/\*{2,}/g, "*");
}

/**
 * The translatable subset (spec 5.5.1): `[^] item* [$]`, an item being a plain
 * character, a backslash before a character that is not an ASCII letter or
 * digit, or `.*` / `.*?`. Null for anything else, including a key KMyMoney
 * could not compile (a trailing backslash).
 */
export function translateKey(key: string): Translated | null {
  const chars = Array.from(key);
  let index = 0;
  const anchoredStart = chars[0] === "^";
  if (anchoredStart) {
    index = 1;
  }
  let anchoredEnd = false;
  let body = "";
  let literalStar = false;
  while (index < chars.length) {
    const char = chars[index];
    if (char === "\\") {
      const next = chars[index + 1];
      if (next === undefined || /[A-Za-z0-9]/.test(next)) {
        return null;
      }
      literalStar = literalStar || next === "*";
      body += next;
      index += 2;
    } else if (char === "$") {
      if (index !== chars.length - 1) {
        return null;
      }
      anchoredEnd = true;
      index += 1;
    } else if (char === ".") {
      if (chars[index + 1] !== "*") {
        return null;
      }
      body += "*";
      index += chars[index + 2] === "?" ? 3 : 2;
    } else if ("^|?*+()[]{}".includes(char)) {
      return null;
    } else {
      body += char;
      index += 1;
    }
  }
  return {
    glob: collapseStars(
      `${anchoredStart ? "" : "*"}${body}${anchoredEnd ? "" : "*"}`,
    ),
    literalStar,
  };
}

function hasCasedLetter(glob: string): boolean {
  return Array.from(glob).some(
    (char) => char !== "*" && char.toLowerCase() !== char.toUpperCase(),
  );
}

function changesLengthWhenLowercased(glob: string): boolean {
  return Array.from(glob).some(
    (char) => char.toLowerCase().length !== char.length,
  );
}

/** Checks 1 to 6 of spec 5.5.1; the first that applies decides. */
function refusalReason(
  translated: Translated,
): Exclude<NotImportedReason, "untranslatable"> | null {
  const { glob } = translated;
  if (translated.literalStar) {
    return "literalStar";
  }
  if (glob === "*") {
    return "matchesEverything";
  }
  if (/[<>]/.test(glob)) {
    return "angleBracket";
  }
  if (glob.trim() !== glob) {
    return "edgeWhitespace";
  }
  if (glob.length > MAX_ALIAS_LENGTH) {
    return "tooLong";
  }
  if (changesLengthWhenLowercased(glob)) {
    return "caseFolding";
  }
  return null;
}

/**
 * One key (or the name, for the name modes) through the checks of spec 5.5.1.
 * Check 7 drops it silently, check 8 imports it with `payeeMatchCaseWidened`.
 */
function evaluate(
  translated: Translated | null,
  key: string,
  caseSensitive: boolean,
  payeeName: string,
): { candidate?: AliasCandidate; warning?: MnyWarning } {
  const subject = `${payeeName}: ${key}`;
  const refused = (detail: NotImportedReason): { warning: MnyWarning } => ({
    warning: { code: "payeeMatchKeyNotImported", subject, detail },
  });
  if (translated === null) {
    return refused("untranslatable");
  }
  const reason = refusalReason(translated);
  if (reason !== null) {
    return refused(reason);
  }
  const { glob } = translated;
  const cased = hasCasedLetter(glob);
  if (!glob.includes("*") && glob === payeeName && (caseSensitive || !cased)) {
    return {};
  }
  if (caseSensitive && cased) {
    return {
      candidate: { glob, key },
      warning: { code: "payeeMatchCaseWidened", subject },
    };
  }
  return { candidate: { glob, key } };
}

/**
 * @param payee the raw payee (its name as written is the pattern source for the
 *   name modes)
 * @param payeeName the payee's trimmed name, the Monize payee it becomes
 */
export function translatePayeeMatch(
  payee: KmyPayee,
  payeeName: string,
): PayeeMatchTranslation {
  const { match } = payee;
  const name = payee.name;
  const caseSensitive = !match.ignoreCase;
  const candidates: AliasCandidate[] = [];
  const warnings: MnyWarning[] = [];
  const take = (result: ReturnType<typeof evaluate>): void => {
    if (result.candidate) {
      candidates.push(result.candidate);
    }
    if (result.warning) {
      warnings.push(result.warning);
    }
  };

  switch (match.kind) {
    case "disabled":
      warnings.push({ code: "payeeMatchingDisabled", subject: payeeName });
      break;
    case "name":
      take(
        evaluate(
          { glob: collapseStars(`*${name}*`), literalStar: name.includes("*") },
          name,
          caseSensitive,
          payeeName,
        ),
      );
      break;
    case "nameExact":
      // Case-sensitive, or nothing to fold: Monize's exact-name tier is the rule.
      if (match.ignoreCase && hasCasedLetter(name)) {
        take(
          evaluate(
            { glob: name, literalStar: name.includes("*") },
            name,
            false,
            payeeName,
          ),
        );
      }
      break;
    case "key":
      for (const key of match.keys) {
        // KMyMoney never matches an empty payee text.
        if (key !== "^$") {
          take(evaluate(translateKey(key), key, caseSensitive, payeeName));
        }
      }
      break;
  }
  return { candidates, warnings };
}
