import type {
  KmyPayee,
  KmyPayeeAddress,
  KmyPayeeMatch,
} from "../model/kmy-raw";
import { attr, readKmyUint } from "./kmy-reader-values";
import type { KmyAttributes } from "./kmy-xml-tokenize";

/** PAYEE attribute decoding (reference 10.1, R10.1; R2.4 for the legacy address names). */

/** The first non-empty value among several attribute names (R2.4 fallbacks). */
function firstNonEmpty(attributes: KmyAttributes, names: string[]): string {
  for (const name of names) {
    const value = attr(attributes, name);
    if (value !== "") {
      return value;
    }
  }
  return "";
}

/**
 * KMyMoney's `setMatchData` split: on a line feed when the value holds one,
 * else on `;` (4.8 files). Empty keys and keys made only of spaces are dropped;
 * a key is never trimmed.
 */
export function splitMatchKeys(matchKey: string): string[] {
  const separator = matchKey.includes("\n") ? "\n" : ";";
  return matchKey.split(separator).filter((key) => /[^ ]/.test(key));
}

export function readPayeeMatch(attributes: KmyAttributes): KmyPayeeMatch {
  const ignoreCase = readKmyUint(attributes.matchignorecase, 0) !== 0;
  if (readKmyUint(attributes.matchingenabled, 0) === 0) {
    return { kind: "disabled", ignoreCase, keys: [] };
  }
  if (readKmyUint(attributes.usingmatchkey, 0) === 0) {
    const exact = attr(attributes, "matchkey") === "^$";
    return { kind: exact ? "nameExact" : "name", ignoreCase, keys: [] };
  }
  return {
    kind: "key",
    ignoreCase,
    keys: splitMatchKeys(attr(attributes, "matchkey")),
  };
}

export function readPayeeAddress(attributes: KmyAttributes): KmyPayeeAddress {
  return {
    street: attr(attributes, "street"),
    city: attr(attributes, "city"),
    state: firstNonEmpty(attributes, ["state", "country", "county"]),
    postcode: firstNonEmpty(attributes, ["zip", "zipcode", "postcode"]),
    telephone: attr(attributes, "telephone"),
  };
}

export const EMPTY_PAYEE_ADDRESS: KmyPayeeAddress = {
  street: "",
  city: "",
  state: "",
  postcode: "",
  telephone: "",
};

export function readPayee(
  ordinal: number,
  attributes: KmyAttributes,
): KmyPayee {
  return {
    ordinal,
    id: attr(attributes, "id"),
    name: attr(attributes, "name"),
    match: readPayeeMatch(attributes),
    defaultAccountId:
      attr(attributes, "defaultaccountid") === ""
        ? null
        : attr(attributes, "defaultaccountid"),
    notes: attr(attributes, "notes"),
    email: attr(attributes, "email"),
    reference: attr(attributes, "reference"),
    address: EMPTY_PAYEE_ADDRESS,
    hasIdentifiers: false,
    hasLinkPattern:
      attr(attributes, "idpattern") !== "" ||
      attr(attributes, "urltemplate") !== "",
  };
}
