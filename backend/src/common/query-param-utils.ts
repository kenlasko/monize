import { BadRequestException } from "@nestjs/common";
import { tr } from "../i18n/translate";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const CURRENCY_CODE_REGEX = /^[A-Za-z]{3}$/;

/**
 * Parse comma-separated ISO 4217 currency codes from a query param, normalized
 * to uppercase. Returns undefined when nothing valid is provided.
 */
export function parseCurrencyCodes(value?: string): string[] | undefined {
  if (!value) return undefined;
  const codes = value
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => c);
  for (const code of codes) {
    if (!CURRENCY_CODE_REGEX.test(code)) {
      throw new BadRequestException(
        tr(
          "errors.common.invalidCurrencyCode",
          `Invalid currency code: ${code}`,
          { code },
        ),
      );
    }
  }
  return codes.length > 0 ? codes : undefined;
}

/**
 * Parse comma-separated UUIDs from query params, with backward compatibility
 * for singular param fallback.
 */
export function parseIds(
  plural?: string,
  singular?: string,
): string[] | undefined {
  if (plural) {
    const ids = plural
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id);
    for (const id of ids) {
      if (!UUID_REGEX.test(id)) {
        throw new BadRequestException(
          tr("errors.common.invalidUuid", `Invalid UUID: ${id}`, { id }),
        );
      }
    }
    return ids.length > 0 ? ids : undefined;
  }
  if (singular) {
    if (!UUID_REGEX.test(singular)) {
      throw new BadRequestException(
        tr("errors.common.invalidUuid", `Invalid UUID: ${singular}`, {
          id: singular,
        }),
      );
    }
    return [singular];
  }
  return undefined;
}

/**
 * Parse comma-separated UUIDs from a single query param value.
 */
export function parseUuids(value?: string): string[] | undefined {
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id);
  for (const id of ids) {
    if (!UUID_REGEX.test(id)) {
      throw new BadRequestException(
        tr("errors.common.invalidUuid", `Invalid UUID: ${id}`, { id }),
      );
    }
  }
  return ids.length > 0 ? ids : undefined;
}

/**
 * Parse comma-separated category IDs that may include special values
 * like 'uncategorized' and 'transfer' in addition to UUIDs.
 */
export function parseCategoryIds(value?: string): string[] | undefined {
  const specialCategoryIds = new Set(["uncategorized", "transfer"]);
  if (!value) return undefined;
  const ids = value
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id);
  for (const id of ids) {
    if (!specialCategoryIds.has(id) && !UUID_REGEX.test(id)) {
      throw new BadRequestException(
        tr("errors.common.invalidCategoryId", `Invalid category ID: ${id}`, {
          id,
        }),
      );
    }
  }
  return ids.length > 0 ? ids : undefined;
}

/** Validate that a string is in YYYY-MM-DD format. */
export function validateDateParam(
  value: string | undefined,
  paramName: string,
): void {
  if (value !== undefined && !DATE_REGEX.test(value)) {
    throw new BadRequestException(
      tr(
        "errors.common.invalidDateParam",
        `${paramName} must be a valid date in YYYY-MM-DD format`,
        { paramName },
      ),
    );
  }
}

/**
 * Assert that a query parameter value is a single string.
 * Express parses duplicated query keys as arrays and nested bracket syntax
 * as objects; both can bypass string-based sanitization because their
 * prototype methods (includes, indexOf, slice, ...) behave differently from
 * String.prototype equivalents (CWE-843). Call this at the controller
 * boundary before using a raw query param with string methods.
 *
 * Uses a strict `typeof === "string"` check so CodeQL recognises this as a
 * dataflow sanitizer for `js/type-confusion-through-parameter-tampering`.
 */
export function assertStringParam(
  value: unknown,
  paramName: string,
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new BadRequestException(
      tr(
        "errors.common.paramMustBeString",
        `${paramName} must be a single string value`,
        { paramName },
      ),
    );
  }
  return value;
}
