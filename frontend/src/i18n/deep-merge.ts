/**
 * Immutable deep merge for translation catalogs.
 *
 * Used to layer a regional variant's partial overrides over its base locale
 * (see `loadNamespace` in `messages.ts`): `override` wins, and nested plain
 * objects are merged recursively rather than replaced, so a variant only needs
 * to declare the leaf strings that differ.
 */

export type CatalogTree = Record<string, unknown>;

export function isPlainObject(value: unknown): value is CatalogTree {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(base: CatalogTree, override: CatalogTree): CatalogTree {
  return Object.keys(override).reduce<CatalogTree>(
    (acc, key) => {
      const baseValue = base[key];
      const overrideValue = override[key];
      return {
        ...acc,
        [key]:
          isPlainObject(baseValue) && isPlainObject(overrideValue)
            ? deepMerge(baseValue, overrideValue)
            : overrideValue,
      };
    },
    { ...base },
  );
}
