import {
  MappedPayee,
  MappedPayeeContact,
  MappedPayees,
  MappedTag,
  MappedTags,
} from "../../mny/model/mny-import-model";
import type { CountryCode } from "libphonenumber-js/max";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { createAliasLedger } from "../../mny/map/payee-alias-collision";
import { matchesAliasPattern } from "../../../payees/alias-match.util";
import { KmyPayee, KmyRawFile } from "../model/kmy-raw";
import { PayeeDefaults, mapPayeeContact } from "./kmy-payee-details";
import { AliasCandidate, translatePayeeMatch } from "./kmy-payee-match";

/**
 * Spec 5.5: payees and tags, referenced-only by default. Payee handles and tag
 * handles are the 1-based ordinals the reader assigned. A payee carries its
 * KMyMoney matching rules as alias globs (5.5.1), its default category (5.5.2)
 * and its contact details (5.5.3); `payeeDetailsNotImported` names the details
 * Monize has no field for and the contact fields it could not store.
 */

export const MAX_TAG_NAME_LENGTH = 100;

export function payeeHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.payees.map((payee) => [payee.id, payee.ordinal]));
}

export function tagHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.tags.map((tag) => [tag.id, tag.ordinal]));
}

/** Details KMyMoney keeps on a payee that Monize has no field for (spec 5.5). */
export function unsupportedDetails(payee: KmyPayee): string[] {
  const fields: string[] = [];
  if (payee.reference !== "") {
    fields.push("reference");
  }
  if (payee.hasIdentifiers) {
    fields.push("payeeIdentifier");
  }
  if (payee.hasLinkPattern) {
    fields.push("idpattern/urltemplate");
  }
  return fields;
}

interface PayeeGroup {
  readonly handle: number;
  readonly name: string;
  readonly key: string;
  readonly members: {
    payee: KmyPayee;
    candidates: readonly AliasCandidate[];
    contact: MappedPayeeContact | null;
  }[];
}

/** Payees of one name ignoring case are one Monize payee: each field is the first one present. */
function mergeContacts(
  contacts: readonly (MappedPayeeContact | null)[],
): MappedPayeeContact | null {
  const first = (field: keyof MappedPayeeContact): string | null =>
    contacts
      .map((contact) => contact?.[field] ?? null)
      .find((v) => v !== null) ?? null;
  const merged = {
    notes: first("notes"),
    email: first("email"),
    phone: first("phone"),
    address: first("address"),
  };
  return Object.values(merged).some((value) => value !== null) ? merged : null;
}

/**
 * Spec 5.5.1: the collision table among the file's own payees, in payee handle
 * then key order, then the per-payee dedupe and subsumption. Two KMyMoney
 * payees that land on one Monize payee share one alias set.
 */
function collideAliases(groups: readonly PayeeGroup[]): {
  aliases: ReadonlyMap<string, readonly string[]>;
  warnings: MnyWarning[];
} {
  const ledger = createAliasLedger(
    groups.map((group) => ({ owner: group.key, name: group.name })),
  );
  const warnings: MnyWarning[] = [];
  const accepted = new Map<string, string[]>();
  for (const group of groups) {
    const own: string[] = [];
    accepted.set(group.key, own);
    for (const { candidates } of group.members) {
      for (const { glob } of candidates) {
        if (own.some((alias) => alias.toLowerCase() === glob.toLowerCase())) {
          continue;
        }
        const decision = ledger.decide(glob, group.key);
        const subject = `${group.name}: ${glob}`;
        if (decision.kind === "conflict") {
          warnings.push({
            code: "payeeMatchKeyConflict",
            subject,
            detail: decision.detail,
          });
          continue;
        }
        ledger.hold(glob, group.key);
        own.push(glob);
        if (decision.overlap !== null) {
          warnings.push({
            code: "payeeMatchKeyOverlap",
            subject,
            detail: decision.overlap,
          });
        }
      }
    }
  }
  const aliases = new Map<string, readonly string[]>();
  for (const [key, own] of accepted) {
    aliases.set(
      key,
      own.filter(
        (alias) =>
          !own.some(
            (other) => other !== alias && matchesAliasPattern(alias, other),
          ),
      ),
    );
  }
  return { aliases, warnings };
}

/** The payees the import writes: referenced (unless every payee is wanted) and named. */
export function writtenPayees(
  raw: KmyRawFile,
  referenced: ReadonlySet<number> | null,
): KmyPayee[] {
  return raw.payees.filter(
    (payee) =>
      payee.name.trim() !== "" &&
      (!referenced || referenced.has(payee.ordinal)),
  );
}

export interface MapPayeesInput {
  /** `resolvePayeeDefaults` of `writtenPayees`: the default categories (5.5.2). */
  readonly defaults: PayeeDefaults;
  /** Region a bare national phone number is read in; null names none (5.5.3). */
  readonly phoneRegion: CountryCode | null;
}

/**
 * @param referenced Payee handles an imported row uses, or null for every payee.
 */
export function mapKmyPayees(
  raw: KmyRawFile,
  referenced: ReadonlySet<number> | null,
  input: MapPayeesInput,
): MappedPayees {
  const warnings: MnyWarning[] = [];
  const nameByHandle = new Map<number, string>();
  const groups = new Map<string, PayeeGroup>();
  let skipped = 0;

  for (const payee of raw.payees) {
    const name = payee.name.trim();
    if (name === "" || (referenced && !referenced.has(payee.ordinal))) {
      skipped += 1;
      continue;
    }
    nameByHandle.set(payee.ordinal, name);
    const key = name.toLowerCase();
    const group = groups.get(key) ?? {
      handle: payee.ordinal,
      name,
      key,
      members: [],
    };
    groups.set(key, group);
    const translation = translatePayeeMatch(payee, name);
    const { contact, notImported } = mapPayeeContact(payee, input.phoneRegion);
    group.members.push({
      payee,
      candidates: translation.candidates,
      contact,
    });
    warnings.push(...translation.warnings);
    const unsupported = [...unsupportedDetails(payee), ...notImported];
    if (unsupported.length > 0) {
      warnings.push({
        code: "payeeDetailsNotImported",
        subject: name,
        detail: unsupported.join(", "),
      });
    }
  }
  warnings.push(...input.defaults.warnings);

  const collided = collideAliases([...groups.values()]);
  warnings.push(...collided.warnings);
  const payees: MappedPayee[] = [...groups.values()].map((group) => {
    const aliases = collided.aliases.get(group.key) ?? [];
    const defaultCategoryHandle = input.defaults.handleByName.get(group.key);
    const contact = mergeContacts(
      group.members.map((member) => member.contact),
    );
    return {
      handle: group.handle,
      name: group.name,
      ...(aliases.length > 0 ? { aliases } : {}),
      ...(defaultCategoryHandle !== undefined ? { defaultCategoryHandle } : {}),
      ...(contact !== null ? { contact } : {}),
    };
  });

  return { payees, nameByHandle, skipped, warnings };
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
