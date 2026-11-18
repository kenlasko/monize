import {
  MappedPayee,
  MappedPayees,
  MappedTag,
  MappedTags,
} from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { AliasLedger } from "../../mny/map/payee-alias-collision";
import { matchesAliasPattern } from "../../../payees/alias-match.util";
import { KmyPayee, KmyRawFile } from "../model/kmy-raw";
import { AliasCandidate, translatePayeeMatch } from "./kmy-payee-match";

/**
 * Spec 5.5: payees and tags, referenced-only by default. Payee handles and tag
 * handles are the 1-based ordinals the reader assigned. A payee carries its
 * KMyMoney matching rules as alias globs (5.5.1); `payeeDetailsNotImported`
 * names only the details Monize has no field for.
 */

export const MAX_TAG_NAME_LENGTH = 100;

export function payeeHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.payees.map((payee) => [payee.id, payee.ordinal]));
}

export function tagHandleById(raw: KmyRawFile): ReadonlyMap<string, number> {
  return new Map(raw.tags.map((tag) => [tag.id, tag.ordinal]));
}

/** Details KMyMoney keeps on a payee that Monize has no field for (spec 5.5). */
function unsupportedDetails(payee: KmyPayee): string[] {
  const fields: string[] = [];
  // Interim: contact details and the default category land in the next commit.
  if (payee.email !== "") {
    fields.push("email");
  }
  if (payee.notes !== "") {
    fields.push("notes");
  }
  if (Object.values(payee.address).some((value) => value !== "")) {
    fields.push("address");
  }
  if (payee.defaultAccountId !== null) {
    fields.push("defaultaccountid");
  }
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
  }[];
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
  const ledger = new AliasLedger(
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

/**
 * @param referenced Payee handles an imported row uses, or null for every payee.
 */
export function mapKmyPayees(
  raw: KmyRawFile,
  referenced: ReadonlySet<number> | null,
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
    group.members.push({ payee, candidates: translation.candidates });
    warnings.push(...translation.warnings);
    const unsupported = unsupportedDetails(payee);
    if (unsupported.length > 0) {
      warnings.push({
        code: "payeeDetailsNotImported",
        subject: name,
        detail: unsupported.join(", "),
      });
    }
  }

  const collided = collideAliases([...groups.values()]);
  warnings.push(...collided.warnings);
  const payees: MappedPayee[] = [...groups.values()].map((group) => {
    const aliases = collided.aliases.get(group.key) ?? [];
    return {
      handle: group.handle,
      name: group.name,
      ...(aliases.length > 0 ? { aliases } : {}),
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
