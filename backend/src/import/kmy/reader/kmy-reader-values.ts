import type { KmyAttributes } from "./kmy-xml-tokenize";

/** Attribute decoding for the KMyMoney reader (reference 2.3, 3.2, 3.3). */

const LEGACY_FIX_VERSION = 5;

// ---------------------------------------------------------------------------
// Attribute decoding (reference 3.2, 3.3)

/** `YYYY-MM-DD` that is a real calendar date, else null. */
export function readKmyDate(text: string | undefined): string | null {
  if (text === undefined) {
    return null;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    return null;
  }
  const [year, month, day] = [+match[1], +match[2], +match[3]];
  const probe = new Date(Date.UTC(year, month - 1, day));
  probe.setUTCFullYear(year);
  const real =
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
  return real ? text : null;
}

/** Attribute booleans: 1/0, on/off, true/false, yes/no, any case; else the default. */
export function readKmyBool(
  text: string | undefined,
  fallback: boolean,
): boolean {
  switch (text?.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    case "0":
    case "off":
    case "false":
    case "no":
      return false;
    default:
      return fallback;
  }
}

/** An unsigned integer attribute; anything else is `fallback`. */
export function readKmyUint(
  text: string | undefined,
  fallback: number,
): number {
  if (text === undefined || !/^\d{1,15}$/.test(text.trim())) {
    return fallback;
  }
  return Number(text.trim());
}

export function readUnsignedBigint(text: string | undefined): bigint {
  return text !== undefined && /^\d+$/.test(text.trim())
    ? BigInt(text.trim())
    : 0n;
}

export function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text === "" ? null : text;
}

export function attr(attributes: KmyAttributes, name: string): string {
  return attributes[name] ?? "";
}

/** The fix version rule of reference 2.3 for a present FIXVERSION element. */
export function readFixVersion(attributes: KmyAttributes): number {
  let version = readKmyUint(attributes.date, 0);
  if (version === 0) {
    const id = attributes.id;
    version =
      id === undefined || id === "" ? LEGACY_FIX_VERSION : readKmyUint(id, 0);
  }
  return version === 2 ? 3 : version;
}
