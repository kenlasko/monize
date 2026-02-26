import { BadRequestException } from "@nestjs/common";

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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
        throw new BadRequestException(`Invalid UUID: ${id}`);
      }
    }
    return ids.length > 0 ? ids : undefined;
  }
  if (singular) {
    if (!UUID_REGEX.test(singular)) {
      throw new BadRequestException(`Invalid UUID: ${singular}`);
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
      throw new BadRequestException(`Invalid UUID: ${id}`);
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
      throw new BadRequestException(`Invalid category ID: ${id}`);
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
      `${paramName} must be a valid date in YYYY-MM-DD format`,
    );
  }
}
