import { isEmail } from "class-validator";
import type { CountryCode } from "libphonenumber-js/max";
import { sanitizeHtmlString } from "../../../common/decorators/sanitize-html.decorator";
import { normalizePhoneNumber } from "../../../common/phone-number.util";
import { MappedPayeeContact } from "../../mny/model/mny-import-model";
import { MnyWarning } from "../../mny/model/mny-warnings";
import { KmyAccount, KmyPayee } from "../model/kmy-raw";
import { KMY_TYPE, isCategoryType } from "./kmy-account-tree";

/**
 * Spec 5.5.2 (default category) and 5.5.3 (contact details), both bounded by
 * the payee DTO (`backend/src/payees/dto/create-payee.dto.ts`) so a payee the
 * import writes can be saved again from its edit form unchanged.
 */

export const MAX_PAYEE_NOTES = 500;
export const MAX_PAYEE_EMAIL = 255;
export const MAX_PAYEE_PHONE = 50;
export const MAX_PAYEE_ADDRESS = 500;

export interface PayeeContactResult {
  readonly contact: MappedPayeeContact | null;
  /** The fields that could not be imported, in the order notes, email, phone, address. */
  readonly notImported: readonly string[];
}

/** One payee's contact details; a field that fails its bound is reported, never trimmed to fit. */
export function mapPayeeContact(
  payee: KmyPayee,
  phoneRegion: CountryCode | null,
): PayeeContactResult {
  const notImported: string[] = [];

  let notes: string | null = null;
  const rawNotes = sanitizeHtmlString(payee.notes).trim();
  if (rawNotes.length > MAX_PAYEE_NOTES) {
    notImported.push("notes");
  } else if (rawNotes !== "") {
    notes = rawNotes;
  }

  let email: string | null = null;
  const rawEmail = payee.email.trim();
  if (rawEmail !== "") {
    if (rawEmail.length > MAX_PAYEE_EMAIL || !isEmail(rawEmail)) {
      notImported.push("email");
    } else {
      email = rawEmail;
    }
  }

  let phone: string | null = null;
  const rawPhone = payee.address.telephone.trim();
  if (rawPhone !== "") {
    const normalized = normalizePhoneNumber(rawPhone, phoneRegion);
    if (normalized.ok && normalized.stored.length <= MAX_PAYEE_PHONE) {
      phone = normalized.stored;
    } else {
      notImported.push("phone");
    }
  }

  let address: string | null = null;
  const { street, city, state, postcode } = payee.address;
  const joined = sanitizeHtmlString(
    [...street.split(/\r\n|\r|\n/), city, state, postcode]
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .join(", "),
  );
  if (joined.length > MAX_PAYEE_ADDRESS) {
    notImported.push("address");
  } else if (joined !== "") {
    address = joined;
  }

  const any =
    notes !== null || email !== null || phone !== null || address !== null;
  return {
    contact: any ? { notes, email, phone, address } : null,
    notImported,
  };
}

/** What `defaultaccountid` means to Monize (spec 5.5.2). */
export interface PayeeDefaults {
  /** Default category handle by lowercased trimmed payee name; one entry per Monize payee. */
  readonly handleByName: ReadonlyMap<string, number>;
  /** Income and expense account handles a written payee's default category references. */
  readonly categoryHandles: ReadonlySet<number>;
  /** Equity account handles the same way (5.4 writes them as categories). */
  readonly equityHandles: ReadonlySet<number>;
  readonly warnings: readonly MnyWarning[];
}

/**
 * @param written the payees the import writes, in handle order (the caller's
 *   referenced-only and empty-name filtering has already happened)
 */
export function resolvePayeeDefaults(
  written: readonly KmyPayee[],
  accounts: readonly KmyAccount[],
): PayeeDefaults {
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const handleByName = new Map<string, number>();
  const categoryHandles = new Set<number>();
  const equityHandles = new Set<number>();
  const warnings: MnyWarning[] = [];

  for (const payee of written) {
    if (payee.defaultAccountId === null) {
      continue;
    }
    const name = payee.name.trim();
    const account = accountById.get(payee.defaultAccountId);
    const isCategory =
      account !== undefined &&
      !account.isStandard &&
      (isCategoryType(account.type) || account.type === KMY_TYPE.EQUITY);
    if (!isCategory) {
      warnings.push({
        code: "payeeDefaultCategoryNotImported",
        subject: name,
        detail: account?.name.trim() || payee.defaultAccountId,
      });
      continue;
    }
    const key = name.toLowerCase();
    const kept = handleByName.get(key);
    if (kept === undefined) {
      handleByName.set(key, account.ordinal);
      (account.type === KMY_TYPE.EQUITY ? equityHandles : categoryHandles).add(
        account.ordinal,
      );
    } else if (kept !== account.ordinal) {
      warnings.push({
        code: "payeeDefaultCategoryNotImported",
        subject: name,
        detail: "sameName",
      });
    }
  }
  return { handleByName, categoryHandles, equityHandles, warnings };
}
