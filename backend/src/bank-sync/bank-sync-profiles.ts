import enCommon from "../i18n/locales/en/common.json";
import {
  BANK_SYNC_PROVIDERS,
  type BankSyncProviderName,
} from "./bank-sync.constants";
import defaultProfileFile from "./profiles/default.json";
import pkoBpProfileFile from "./profiles/pl/pko-bp.json";

/**
 * Source profiles for bank sync, in their first form (docs/future-plans/
 * source-profiles.md sections 3 and 4): how one bank writes what Monize reads
 * from it, as a reviewed file in the repository rather than code. Today a
 * profile says where the bank puts the operation type and which tag label each
 * known operation code gets (docs/specs/bank-sync.md section 7b); payees,
 * descriptions and structure join in later tasks.
 *
 * **A profile never changes the duplicate key (invariant S1).** Nothing here is
 * read by `planBankImport`'s key or hash; a profile only names the tag a row
 * gets.
 *
 * **A shared profile carries no personal data (invariant S2).** Every file is
 * checked at load by `assertNoPersonalData` before its shape is, and a file that
 * holds an account-number-like digit run, an IBAN-like string, an amount or an
 * e-mail address is refused. The refusal names the place in the file and never
 * repeats the string: the string is the thing that must not travel.
 *
 * The files are imported as JSON modules (`resolveJsonModule`), so the compiler
 * copies each one into `dist/` beside this file and a build cannot ship without
 * them; `BankSyncModule.onModuleInit` loads them, so a broken file stops the
 * boot rather than the first sync.
 */

/** Where a bank puts the operation type. Listed in the order it is looked for. */
export type OperationLocation = "bank_transaction_code" | "remittance_line";

const OPERATION_LOCATIONS: readonly OperationLocation[] = [
  "bank_transaction_code",
  "remittance_line",
];

/** Which way the money moved, as the bank reported it. */
export type OperationDirection = "credit" | "debit";

/**
 * How an operation code is recognised, compared with the code upper-cased: the
 * whole code (`exact`), or its start and/or its end (`prefix`, `suffix`).
 */
export interface OperationMatch {
  readonly exact?: string;
  readonly prefix?: string;
  readonly suffix?: string;
}

/** A known operation with its own tag label. */
export interface LabelledOperationType {
  /**
   * What names the operation: the family of a known code (`CARD-PAYMENT`,
   * `MOBILE-PAYMENT`, `ATM`). Unique in a profile.
   */
  readonly key: string;
  readonly match: OperationMatch;
  /** A key under `common.bankSync.operationTypes` in the catalogue. */
  readonly label: string;
}

/**
 * A code that does not say which way the money moved (a bare `TRANSFER`): the
 * direction picks one of the labelled types of the same profile, by its `key`.
 * Without a direction the code is unknown, and so its own tag name.
 */
export interface DirectedOperationType {
  readonly match: OperationMatch;
  readonly byDirection: Readonly<Record<OperationDirection, string>>;
}

export type ProfileOperationType =
  | LabelledOperationType
  | DirectedOperationType;

/** A validated profile. Its order is match order: the first type that matches wins. */
export interface BankSyncProfile {
  /** `default`, or `<country>/<bank>` in lower case (`pl/pko-bp`). */
  readonly id: string;
  /** Bumped when the file changes what a row is given. */
  readonly version: number;
  readonly source: BankSyncProviderName;
  /** The bank the profile is for; null for the default profile. */
  readonly institution: {
    readonly country: string;
    readonly names: readonly string[];
  } | null;
  readonly operation: { readonly location: readonly OperationLocation[] };
  readonly types: readonly ProfileOperationType[];
}

/** What a matched operation type gives a row's tag. */
export interface MatchedOperationType {
  readonly key: string;
  /** The catalogue key under `common.bankSync.operationTypes`. */
  readonly catalogKey: string;
  /** The English source, returned when a locale has no entry. */
  readonly fallback: string;
}

export const DEFAULT_PROFILE_ID = "default";

/** A profile file that is malformed, or that must not be shared. */
export class BankSyncProfileError extends Error {
  constructor(origin: string, path: string, problem: string) {
    super(`Bank sync profile ${origin}: ${path}: ${problem}`);
    this.name = "BankSyncProfileError";
  }
}

// -- Personal data (S2) --------------------------------------------------------

/** Eight or more digits, with at most a space or a hyphen between two of them. */
const DIGIT_RUN = /\d(?:[ -]?\d){7,}/;
/** Two letters, two check digits and a long tail, as an IBAN is, spaces aside. */
const IBAN_LIKE = /[A-Z]{2}\d{2}[A-Z0-9]{10,}/;
/** A number with decimals (`12.34`, `7,5`), or digits followed by a currency code. */
const AMOUNT_LIKE = /\d[.,]\d|\d\s*[A-Z]{3}\b/;
const EMAIL_LIKE = /@/;

/** What makes `value` look like personal data, or null. */
function personalDataReason(value: string): string | null {
  if (DIGIT_RUN.test(value)) return "a run of eight or more digits";
  if (IBAN_LIKE.test(value.replace(/\s+/g, "").toUpperCase())) {
    return "an account number";
  }
  if (AMOUNT_LIKE.test(value)) return "an amount";
  if (EMAIL_LIKE.test(value)) return "an e-mail address";
  return null;
}

/**
 * Refuse a profile file that holds anything that looks like personal data: an
 * account or card number, an amount, an e-mail address. Every string anywhere in
 * the file is read, whatever the shape it is in. The message names where, never
 * what.
 */
export function assertNoPersonalData(raw: unknown, origin: string): void {
  const visit = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      const reason = personalDataReason(value);
      if (reason !== null) {
        throw new BankSyncProfileError(
          origin,
          path,
          `looks like ${reason}; a shared profile holds operation codes and bank names only`,
        );
      }
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        visit(item, path === "" ? key : `${path}.${key}`);
      }
    }
  };
  visit(raw, "");
}

// -- Shape ---------------------------------------------------------------------

const PROFILE_ID = /^(?:default|[a-z]{2}\/[a-z0-9]+(?:-[a-z0-9]+)*)$/;
const COUNTRY = /^[A-Z]{2}$/;
const INSTITUTION_NAME = /^[\p{L}\p{N}][\p{L}\p{N} .,&'()/-]*$/u;
const INSTITUTION_NAME_MAX_LENGTH = 100;
const MAX_INSTITUTION_NAMES = 20;
const MAX_TYPES = 200;
const TYPE_KEY = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const EXACT_CODE = TYPE_KEY;
const PREFIX_CODE = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-$/;
const SUFFIX_CODE = /^-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const DIRECTIONS: readonly OperationDirection[] = ["credit", "debit"];

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The operation-type labels the catalogue has, by key. */
const OPERATION_LABELS: Readonly<Record<string, string>> =
  enCommon.bankSync.operationTypes;

function fail(origin: string, path: string, problem: string): never {
  throw new BankSyncProfileError(origin, path, problem);
}

function expectDict(value: unknown, origin: string, path: string): Dict {
  if (!isDict(value)) fail(origin, path, "must be an object");
  return value;
}

/** Refuse a field the format does not have: an unknown name is a typo or a smuggled value. */
function expectOnly(
  value: Dict,
  allowed: readonly string[],
  origin: string,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      fail(
        origin,
        path === "" ? key : `${path}.${key}`,
        "is not a field of a profile",
      );
    }
  }
}

function expectString(
  value: unknown,
  pattern: RegExp,
  origin: string,
  path: string,
  what: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(origin, path, `must be ${what}`);
  }
  return value;
}

function validateMatch(
  value: unknown,
  origin: string,
  path: string,
): OperationMatch {
  const match = expectDict(value, origin, path);
  expectOnly(match, ["exact", "prefix", "suffix"], origin, path);
  const hasExact = match.exact !== undefined;
  if (hasExact && (match.prefix !== undefined || match.suffix !== undefined)) {
    fail(
      origin,
      path,
      "takes an exact code, or a prefix and/or a suffix, not both",
    );
  }
  if (!hasExact && match.prefix === undefined && match.suffix === undefined) {
    fail(origin, path, "needs an exact code, a prefix or a suffix");
  }
  return {
    ...(hasExact && {
      exact: expectString(
        match.exact,
        EXACT_CODE,
        origin,
        `${path}.exact`,
        "an upper-case code such as CARD-PAYMENT",
      ),
    }),
    ...(match.prefix !== undefined && {
      prefix: expectString(
        match.prefix,
        PREFIX_CODE,
        origin,
        `${path}.prefix`,
        "an upper-case code ending in a hyphen, such as ATM-",
      ),
    }),
    ...(match.suffix !== undefined && {
      suffix: expectString(
        match.suffix,
        SUFFIX_CODE,
        origin,
        `${path}.suffix`,
        "an upper-case code starting with a hyphen, such as -RETURN",
      ),
    }),
  };
}

function validateInstitution(
  value: unknown,
  origin: string,
): NonNullable<BankSyncProfile["institution"]> {
  const institution = expectDict(value, origin, "institution");
  expectOnly(institution, ["country", "names"], origin, "institution");
  const country = expectString(
    institution.country,
    COUNTRY,
    origin,
    "institution.country",
    "an upper-case ISO 3166-1 alpha-2 country code",
  );
  const names = institution.names;
  if (
    !Array.isArray(names) ||
    names.length < 1 ||
    names.length > MAX_INSTITUTION_NAMES
  ) {
    fail(
      origin,
      "institution.names",
      `must list one to ${MAX_INSTITUTION_NAMES} institution names`,
    );
  }
  const seen = new Set<string>();
  return {
    country,
    names: names.map((name, index) => {
      const path = `institution.names[${index}]`;
      const text = expectString(
        name,
        INSTITUTION_NAME,
        origin,
        path,
        "plain text starting with a letter or a digit",
      );
      if (text.length > INSTITUTION_NAME_MAX_LENGTH) {
        fail(
          origin,
          path,
          `must be at most ${INSTITUTION_NAME_MAX_LENGTH} characters`,
        );
      }
      const normalized = normalizeInstitutionName(text);
      if (seen.has(normalized)) {
        fail(
          origin,
          path,
          "repeats another name once case and spacing are ignored",
        );
      }
      seen.add(normalized);
      return text;
    }),
  };
}

function validateOperation(
  value: unknown,
  origin: string,
): BankSyncProfile["operation"] {
  const operation = expectDict(value, origin, "operation");
  expectOnly(operation, ["location"], origin, "operation");
  const location = operation.location;
  if (
    !Array.isArray(location) ||
    location.length < 1 ||
    location.length > OPERATION_LOCATIONS.length ||
    new Set(location).size !== location.length ||
    !location.every((item) => OPERATION_LOCATIONS.includes(item))
  ) {
    fail(
      origin,
      "operation.location",
      `must list each of ${OPERATION_LOCATIONS.join(", ")} at most once, in the order they are looked for`,
    );
  }
  return { location: Object.freeze([...location]) as OperationLocation[] };
}

function validateTypes(
  value: unknown,
  origin: string,
): readonly ProfileOperationType[] {
  if (!Array.isArray(value) || value.length > MAX_TYPES) {
    fail(origin, "types", `must be a list of at most ${MAX_TYPES} types`);
  }
  const types = value.map((item, index): ProfileOperationType => {
    const path = `types[${index}]`;
    const type = expectDict(item, origin, path);
    expectOnly(type, ["key", "match", "label", "byDirection"], origin, path);
    const match = validateMatch(type.match, origin, `${path}.match`);

    if (type.byDirection !== undefined) {
      if (type.key !== undefined || type.label !== undefined) {
        fail(origin, path, "takes a label and a key, or byDirection, not both");
      }
      const byDirection = expectDict(
        type.byDirection,
        origin,
        `${path}.byDirection`,
      );
      expectOnly(byDirection, DIRECTIONS, origin, `${path}.byDirection`);
      const [credit, debit] = DIRECTIONS.map((direction) =>
        expectString(
          byDirection[direction],
          TYPE_KEY,
          origin,
          `${path}.byDirection.${direction}`,
          "the key of a type of this profile",
        ),
      );
      return { match, byDirection: Object.freeze({ credit, debit }) };
    }

    const key = expectString(
      type.key,
      TYPE_KEY,
      origin,
      `${path}.key`,
      "an upper-case family name such as CARD-PAYMENT",
    );
    const label = expectString(
      type.label,
      /^[A-Za-z][A-Za-z0-9]*$/,
      origin,
      `${path}.label`,
      "a label key under common.bankSync.operationTypes",
    );
    if (!Object.prototype.hasOwnProperty.call(OPERATION_LABELS, label)) {
      fail(
        origin,
        `${path}.label`,
        "is not a key under common.bankSync.operationTypes in the English catalogue",
      );
    }
    return { key, match, label };
  });

  const keys = new Set<string>();
  types.forEach((type, index) => {
    if (!("key" in type)) return;
    if (keys.has(type.key)) {
      fail(origin, `types[${index}].key`, "repeats the key of an earlier type");
    }
    keys.add(type.key);
  });
  types.forEach((type, index) => {
    if (!("byDirection" in type)) return;
    for (const direction of DIRECTIONS) {
      if (!keys.has(type.byDirection[direction])) {
        fail(
          origin,
          `types[${index}].byDirection.${direction}`,
          "names no type of this profile",
        );
      }
    }
  });
  return Object.freeze(types);
}

/**
 * Check one profile file and return it as a frozen profile. `origin` names the
 * file in every message. The personal-data check runs first, over the raw file:
 * a value that must not be shared is refused before anything reads it.
 */
export function validateBankSyncProfile(
  raw: unknown,
  origin: string,
): BankSyncProfile {
  assertNoPersonalData(raw, origin);
  const file = expectDict(raw, origin, "profile");
  expectOnly(
    file,
    ["id", "version", "source", "institution", "operation", "types"],
    origin,
    "",
  );
  const id = expectString(
    file.id,
    PROFILE_ID,
    origin,
    "id",
    "`default`, or `<country>/<bank>` in lower case, such as pl/pko-bp",
  );
  if (
    typeof file.version !== "number" ||
    !Number.isInteger(file.version) ||
    file.version < 1
  ) {
    fail(origin, "version", "must be a whole number from 1");
  }
  const source = file.source;
  if (!BANK_SYNC_PROVIDERS.includes(source as BankSyncProviderName)) {
    fail(origin, "source", `must be one of ${BANK_SYNC_PROVIDERS.join(", ")}`);
  }

  let institution: BankSyncProfile["institution"] = null;
  if (id === DEFAULT_PROFILE_ID) {
    if (file.institution !== undefined) {
      fail(
        origin,
        "institution",
        "the default profile is for every bank and names none",
      );
    }
  } else {
    institution = validateInstitution(file.institution, origin);
    if (id.slice(0, 2) !== institution.country.toLowerCase()) {
      fail(origin, "id", "must start with the institution's country code");
    }
  }

  return Object.freeze({
    id,
    version: file.version,
    source: source as BankSyncProviderName,
    institution: institution && Object.freeze(institution),
    operation: Object.freeze(validateOperation(file.operation, origin)),
    types: validateTypes(file.types, origin),
  });
}

// -- Loading and choosing ------------------------------------------------------

/**
 * Every built-in profile file, with the name it is reported under. A new file is
 * one import and one line here; `bank-sync-profiles.spec.ts` fails when a file
 * under `profiles/` is missing from this list.
 */
export interface ProfileFile {
  /** The file's name, as every message about it reports it. */
  origin: string;
  raw: unknown;
}

const BUILT_IN_FILES: readonly ProfileFile[] = [
  { origin: "pl/pko-bp.json", raw: pkoBpProfileFile },
];

const DEFAULT_FILE: ProfileFile = {
  origin: "default.json",
  raw: defaultProfileFile,
};

/** An institution name as profiles compare it: composed, trimmed, spaces collapsed, lower case. */
export function normalizeInstitutionName(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

export interface LoadedProfiles {
  readonly defaultProfile: BankSyncProfile;
  readonly builtIn: readonly BankSyncProfile[];
  /** `source|COUNTRY|normalized name` to the built-in profile of that bank. */
  readonly byInstitution: ReadonlyMap<string, BankSyncProfile>;
}

const institutionKey = (
  source: string,
  country: string,
  name: string,
): string =>
  `${source}|${country.trim().toUpperCase()}|${normalizeInstitutionName(name)}`;

/**
 * Validate a default file and a list of built-in files and index them. Throws a
 * `BankSyncProfileError` for the first file that is malformed, carries personal
 * data, is not the default but names no bank, repeats another profile's id, or
 * claims a bank another profile already claims. Exported for the spec, which
 * feeds it files the repository does not hold.
 */
export function buildProfileSet(
  defaultFile: ProfileFile,
  builtInFiles: readonly ProfileFile[],
): LoadedProfiles {
  const defaultProfile = validateBankSyncProfile(
    defaultFile.raw,
    defaultFile.origin,
  );
  if (defaultProfile.id !== DEFAULT_PROFILE_ID) {
    fail(defaultFile.origin, "id", `must be ${DEFAULT_PROFILE_ID}`);
  }
  const builtIn: BankSyncProfile[] = [];
  const byInstitution = new Map<string, BankSyncProfile>();
  const ids = new Set<string>([DEFAULT_PROFILE_ID]);
  for (const { origin, raw } of builtInFiles) {
    const profile = validateBankSyncProfile(raw, origin);
    if (profile.institution === null) {
      fail(
        origin,
        "id",
        `${DEFAULT_PROFILE_ID} is the one profile that names no bank`,
      );
    }
    if (ids.has(profile.id)) {
      fail(origin, "id", "repeats the id of another profile");
    }
    ids.add(profile.id);
    for (const name of profile.institution.names) {
      const key = institutionKey(
        profile.source,
        profile.institution.country,
        name,
      );
      if (byInstitution.has(key)) {
        fail(
          origin,
          "institution.names",
          "names a bank another profile is for",
        );
      }
      byInstitution.set(key, profile);
    }
    builtIn.push(profile);
  }
  return Object.freeze({
    defaultProfile,
    builtIn: Object.freeze(builtIn),
    byInstitution,
  });
}

let loaded: LoadedProfiles | null = null;

/**
 * Load and validate every profile file, once. Called when the module
 * initialises so the application does not start with a broken profile; a failed
 * load is not remembered, so it fails the same way each time it is asked.
 */
export function loadBankSyncProfiles(): LoadedProfiles {
  loaded ??= buildProfileSet(DEFAULT_FILE, BUILT_IN_FILES);
  return loaded;
}

/**
 * The profile for a connection's institution: the built-in profile of that bank
 * when there is one, else the default. The institution is matched by the
 * provider, the country (upper-cased) and the name the provider uses, ignoring
 * case and the spacing; it is never matched on a substring, so a profile is only
 * ever chosen for a bank it was written for.
 */
export function resolveProfile(
  provider: string,
  institutionCountry: string,
  institutionName: string,
): BankSyncProfile {
  const { byInstitution, defaultProfile } = loadBankSyncProfiles();
  return (
    byInstitution.get(
      institutionKey(provider, institutionCountry, institutionName),
    ) ?? defaultProfile
  );
}

// -- Reading a profile ---------------------------------------------------------

function matchesCode(match: OperationMatch, code: string): boolean {
  if (match.exact !== undefined) return code === match.exact;
  return (
    (match.prefix === undefined || code.startsWith(match.prefix)) &&
    (match.suffix === undefined || code.endsWith(match.suffix))
  );
}

function matched(type: LabelledOperationType): MatchedOperationType {
  return {
    key: type.key,
    catalogKey: type.label,
    fallback: OPERATION_LABELS[type.label],
  };
}

/**
 * The first type of the profile that `code` (upper-cased) is, or null when it is
 * none. `direction` is the way the money moved, for the code that does not say it
 * itself: a type that needs one is skipped without it.
 */
export function findOperationType(
  profile: BankSyncProfile,
  code: string,
  direction: OperationDirection | null,
): MatchedOperationType | null {
  for (const type of profile.types) {
    if (!matchesCode(type.match, code)) continue;
    if ("byDirection" in type) {
      if (direction === null) continue;
      const target = profile.types.find(
        (candidate): candidate is LabelledOperationType =>
          "key" in candidate && candidate.key === type.byDirection[direction],
      );
      if (target !== undefined) return matched(target);
      continue;
    }
    return matched(type);
  }
  return null;
}
