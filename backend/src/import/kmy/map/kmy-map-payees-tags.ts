import {
  MappedPayee,
  MappedPayees,
  MappedTag,
  MappedTags,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyRawFile } from "../model/kmy-raw";

/**
 * Spec 5.5: payees and tags, referenced-only by default. Payee handles and tag
 * handles are the 1-based ordinals the reader assigned.
 *
 * PAYEE-DROP LOCATION (follow-on package): `payeeDetailsNotImported` is raised
 * here, once per imported payee whose raw `hasDetails` is set (email,
 * reference, notes, address, identifiers, default category, matching rules).
 * The raw model carries only that boolean, so importing matching rules and the
 * default category also needs the reader and `KmyPayee` extended.
 */

export const MAX_TAG_NAME_LENGTH = 100;

export function payeeHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.payees.map((payee) => [payee.id, payee.ordinal]));
}

export function tagHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.tags.map((tag) => [tag.id, tag.ordinal]));
}

/**
 * @param referenced Payee handles an imported row uses, or null for every payee.
 */
export function mapKmyPayees(
  raw: KmyRawFile,
  referenced: ReadonlySet<number> | null,
): MappedPayees {
  const warnings: MnyWarning[] = [];
  const nameByHandle = new Map<number, string>();
  const unique = new Map<string, MappedPayee>();
  let skipped = 0;

  for (const payee of raw.payees) {
    const name = payee.name.trim();
    if (name === "" || (referenced && !referenced.has(payee.ordinal))) {
      skipped += 1;
      continue;
    }
    nameByHandle.set(payee.ordinal, name);
    if (!unique.has(name.toLowerCase())) {
      unique.set(name.toLowerCase(), { handle: payee.ordinal, name });
    }
    if (payee.hasDetails) {
      warnings.push({ code: "payeeDetailsNotImported", subject: name });
    }
  }

  return { payees: [...unique.values()], nameByHandle, skipped, warnings };
}

/**
 * @param referenced Tag handles an imported row, leg or selected bill carries.
 *   Only referenced tags are created.
 */
export function mapKmyTags(
  raw: KmyRawFile,
  referenced: ReadonlySet<number>,
): MappedTags {
  const byHandle = new Map<number, MappedTag>();
  const unique = new Map<string, MappedTag>();
  let skipped = 0;

  for (const tag of raw.tags) {
    const name = tag.name.trim().slice(0, MAX_TAG_NAME_LENGTH);
    if (name === "" || !referenced.has(tag.ordinal)) {
      skipped += 1;
      continue;
    }
    // Tag names are unique per user case-insensitively: two that differ only
    // in case become one tag and both handles map to it.
    const mapped = unique.get(name.toLowerCase()) ?? {
      handle: tag.ordinal,
      name,
    };
    unique.set(name.toLowerCase(), mapped);
    byHandle.set(tag.ordinal, mapped);
  }

  return {
    tags: [...unique.values()],
    byHandle,
    inFile: raw.tags.length,
    skipped,
    warnings: [],
  };
}
