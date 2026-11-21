import {
  brokerageSuffix,
  cashSuffix,
} from "../../../accounts/account-name.util";
import type {
  MnyNameFix,
  MnyNameFixes,
} from "../../mny/model/mny-import-model";
import type {
  MnyRename,
  MnyRenameKind,
} from "../../mny/model/mny-import-options";
import { KmyAccount, KmyRawFile } from "../model/kmy-raw";
import { KMY_TYPE, MONIZE_TYPE, isCategoryType } from "./kmy-account-tree";
import { MAX_TAG_NAME_LENGTH } from "./kmy-map-payees-tags";

/**
 * Issue #2313: a KMyMoney name can be any length (a payee created from a SEPA
 * direct debit carries the whole remittance text), while the Monize columns
 * it is written to (`payees.name`, `accounts.name`, `categories.name`,
 * `securities.name`, `scheduled_transactions.name`, `accounts.institution`)
 * are `VARCHAR(255)`. An INSERT of a longer one failed the whole import; a
 * tag (`tags.name VARCHAR(100)`) was cut without a word, so two could merge.
 *
 * Each too-long name is listed in the preview so the user can choose a
 * shorter one (`options.renames`), and is replaced in the raw model before
 * anything is mapped, so every place the name is copied to (a transaction's
 * `payee_name`, a schedule named after its payee, an investment pair's two
 * names) reads the same replacement. A name with no usable rename is cut to
 * fit: the import never fails on a name's length.
 */

/** Width of every name column a KMyMoney name is written to, tags aside. */
export const KMY_MAX_NAME_LENGTH = 255;

/**
 * The most too-long names the preview lists. Past it the rest are cut to fit
 * and only counted, so a hostile file cannot grow the preview without bound.
 */
export const KMY_MAX_NAME_FIXES = 1_000;

/** The most characters of a too-long name the preview carries. */
export const KMY_NAME_FIX_ORIGINAL_CHARS = 1_000;

const SURROGATE = /[\uD800-\uDFFF]/;

/** Length in characters as PostgreSQL counts a VARCHAR's: code points. */
export function nameLength(text: string): number {
  // Only a surrogate pair makes the UTF-16 length differ.
  return SURROGATE.test(text) ? [...text].length : text.length;
}

/** The first `max` code points of `text`, never splitting a surrogate pair. */
export function clipName(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  return [...text].slice(0, max).join("");
}

/**
 * `base` followed by `suffix`, with `base` cut so the whole stays within the
 * column. Used where the mapper appends to a name (an investment pair's
 * " - Cash", a duplicate's " (2)").
 */
export function fitName(base: string, suffix: string): string {
  return (
    clipName(base, Math.max(0, KMY_MAX_NAME_LENGTH - nameLength(suffix))) +
    suffix
  );
}

/**
 * Characters an investment account's name loses to the pair suffix: the
 * longest of this locale's two words and the English ones, since the preview
 * runs in a request and the job may not.
 */
function pairSuffixReserve(): number {
  return (
    " - ".length +
    Math.max(
      ...["Cash", "Brokerage", cashSuffix(), brokerageSuffix()].map(nameLength),
    )
  );
}

function accountKind(account: KmyAccount): MnyRenameKind | null {
  if (account.isStandard) {
    return null;
  }
  if (isCategoryType(account.type) || account.type === KMY_TYPE.EQUITY) {
    return "category";
  }
  if (MONIZE_TYPE.has(account.type) || account.type === KMY_TYPE.INVESTMENT) {
    return "account";
  }
  return null;
}

interface NamedElement {
  readonly kind: MnyRenameKind;
  readonly handle: number;
  readonly name: string;
  readonly maxLength: number;
}

function* namedElements(raw: KmyRawFile): Generator<NamedElement> {
  for (const payee of raw.payees) {
    yield {
      kind: "payee",
      handle: payee.ordinal,
      name: payee.name.trim(),
      maxLength: KMY_MAX_NAME_LENGTH,
    };
  }
  const reserve = pairSuffixReserve();
  for (const account of raw.accounts) {
    const kind = accountKind(account);
    if (kind !== null) {
      yield {
        kind,
        handle: account.ordinal,
        name: account.name.trim(),
        maxLength:
          account.type === KMY_TYPE.INVESTMENT
            ? KMY_MAX_NAME_LENGTH - reserve
            : KMY_MAX_NAME_LENGTH,
      };
    }
  }
  for (const security of raw.securities) {
    yield {
      kind: "security",
      handle: security.ordinal,
      name: security.name.trim(),
      maxLength: KMY_MAX_NAME_LENGTH,
    };
  }
  for (const schedule of raw.schedules) {
    yield {
      kind: "schedule",
      handle: schedule.ordinal,
      name: schedule.name.trim(),
      maxLength: KMY_MAX_NAME_LENGTH,
    };
  }
  for (const institution of raw.institutions) {
    yield {
      kind: "institution",
      handle: institution.ordinal,
      name: institution.name.trim(),
      maxLength: KMY_MAX_NAME_LENGTH,
    };
  }
  for (const tag of raw.tags) {
    yield {
      kind: "tag",
      handle: tag.ordinal,
      name: tag.name.trim(),
      maxLength: MAX_TAG_NAME_LENGTH,
    };
  }
}

function renameKey(kind: MnyRenameKind, handle: number): string {
  return `${kind}:${handle}`;
}

export interface KmyNameFixResult {
  /** The file with every too-long name replaced. */
  readonly raw: KmyRawFile;
  readonly fixes: MnyNameFixes;
  /** The name each listed fix is imported under, for `options.renames`. */
  readonly renames: readonly MnyRename[];
}

/**
 * Replaces every too-long name in `raw` with the user's rename when it is
 * usable (not blank and within the column once trimmed), else with the name
 * cut to fit. A rename of a name that already fits is ignored.
 */
export function applyKmyNameFixes(
  raw: KmyRawFile,
  requested: readonly MnyRename[],
): KmyNameFixResult {
  const wanted = new Map<string, string>();
  for (const rename of requested) {
    wanted.set(renameKey(rename.kind, rename.handle), rename.name.trim());
  }

  const chosen = new Map<string, string>();
  const entries: MnyNameFix[] = [];
  const renames: MnyRename[] = [];
  let omitted = 0;
  for (const element of namedElements(raw)) {
    const length = nameLength(element.name);
    if (length <= element.maxLength) {
      continue;
    }
    const key = renameKey(element.kind, element.handle);
    const own = wanted.get(key);
    const name =
      own !== undefined && own !== "" && nameLength(own) <= element.maxLength
        ? own
        : clipName(element.name, element.maxLength).trimEnd();
    chosen.set(key, name);
    if (entries.length >= KMY_MAX_NAME_FIXES) {
      omitted += 1;
      continue;
    }
    entries.push({
      kind: element.kind,
      handle: element.handle,
      original: clipName(element.name, KMY_NAME_FIX_ORIGINAL_CHARS),
      originalLength: length,
      maxLength: element.maxLength,
    });
    renames.push({ kind: element.kind, handle: element.handle, name });
  }

  if (chosen.size === 0) {
    return { raw, fixes: { entries, omitted }, renames };
  }

  const rename = <T extends { ordinal: number; name: string }>(
    kind: MnyRenameKind | null,
    item: T,
  ): T => {
    const name =
      kind === null ? undefined : chosen.get(renameKey(kind, item.ordinal));
    return name === undefined ? item : { ...item, name };
  };
  return {
    raw: {
      ...raw,
      payees: raw.payees.map((payee) => rename("payee", payee)),
      accounts: raw.accounts.map((account) =>
        rename(accountKind(account), account),
      ),
      securities: raw.securities.map((security) =>
        rename("security", security),
      ),
      schedules: raw.schedules.map((schedule) => rename("schedule", schedule)),
      institutions: raw.institutions.map((institution) =>
        rename("institution", institution),
      ),
      tags: raw.tags.map((tag) => rename("tag", tag)),
    },
    fixes: { entries, omitted },
    renames,
  };
}
