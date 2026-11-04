import { isValidYMD } from "./calendar-date";
import { ExactDecimal } from "./exact-decimal";

export type BondTermsErrorCode = "INVALID" | "UNSUPPORTED_PRIMITIVE";

export class BondTermsError extends Error {
  constructor(
    readonly field: string,
    detail: string,
    readonly code: BondTermsErrorCode = "INVALID",
  ) {
    super(`Invalid bond terms: ${field}: ${detail}`);
    this.name = "BondTermsError";
  }
}

export type Json = Record<string, unknown>;

export function object(
  value: unknown,
  path: string,
  allowed: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BondTermsError(path, "must be an object");
  }
  const record = value as Json;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key) && !optional.includes(key))
      throw new BondTermsError(`${path}.${key}`, "unknown field");
  }
  for (const key of allowed) {
    if (!(key in record)) throw new BondTermsError(`${path}.${key}`, "missing");
  }
  return record;
}

/** Reads the `type` discriminant; an unknown one is an unsupported primitive. */
export function primitive<T extends string>(
  value: unknown,
  path: string,
  known: readonly T[],
): T {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BondTermsError(path, "must be an object");
  }
  const type = (value as Json).type;
  if (typeof type !== "string")
    throw new BondTermsError(`${path}.type`, "must be a string");
  if (!known.includes(type as T)) {
    throw new BondTermsError(
      `${path}.type`,
      `unsupported primitive ${JSON.stringify(type)}; supported: ${known.join(", ")}`,
      "UNSUPPORTED_PRIMITIVE",
    );
  }
  return type as T;
}

export function oneOf<T extends string>(
  value: unknown,
  path: string,
  options: readonly T[],
): T {
  if (typeof value !== "string" || !options.includes(value as T)) {
    throw new BondTermsError(path, `must be one of ${options.join(", ")}`);
  }
  return value as T;
}

export function exact<T>(value: unknown, path: string, expected: T): T {
  if (value !== expected)
    throw new BondTermsError(path, `must be ${JSON.stringify(expected)}`);
  return expected;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new BondTermsError(path, "must be a non-empty string");
  }
  return value;
}

export function code(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new BondTermsError(path, `must match ${pattern}`);
  }
  return value;
}

export function integer(value: unknown, path: string, min: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) {
    throw new BondTermsError(path, `must be an integer >= ${min}`);
  }
  return value as number;
}

/** A non-negative decimal string; a JSON number is refused (INV-BOND-003). */
export function decimal(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new BondTermsError(path, "must be a decimal string, not a number");
  }
  let parsed: ExactDecimal;
  try {
    parsed = ExactDecimal.parse(value);
  } catch {
    throw new BondTermsError(path, `not a decimal string: ${value}`);
  }
  if (parsed.isNegative())
    throw new BondTermsError(path, "must not be negative");
  return value;
}

export function nullable<T>(value: unknown, read: (v: unknown) => T): T | null {
  return value === null ? null : read(value);
}

export function date(value: unknown, path: string): string {
  if (!isValidYMD(value))
    throw new BondTermsError(path, "must be a YYYY-MM-DD date");
  return value;
}

export function list<T>(
  value: unknown,
  path: string,
  read: (item: unknown, at: string) => T,
): T[] {
  if (!Array.isArray(value)) throw new BondTermsError(path, "must be an array");
  return value.map((item, i) => read(item, `${path}[${i}]`));
}
