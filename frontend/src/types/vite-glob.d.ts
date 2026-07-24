/**
 * Type declaration for Vite/Vitest's `import.meta.glob` build-time macro.
 *
 * We use it in `src/test/render.tsx` to eagerly load every English message
 * namespace for component tests. The full `vite/client` types pull in ambient
 * module declarations (CSS, assets) that overlap with Next.js's own types, so
 * we declare only the narrow `glob` signature we rely on.
 */
interface ImportMeta {
  glob<T = Record<string, unknown>>(
    pattern: string | string[],
    options: { eager: true },
  ): Record<string, T>;
  // Raw-string variant used by the tour anchor-uniqueness test to scan source.
  glob(
    pattern: string | string[],
    options: { query: '?raw'; eager: true; import: 'default' },
  ): Record<string, string>;
}
