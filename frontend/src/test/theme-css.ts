import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Reads the theme stylesheets and resolves a theme's tokens the way the
 * cascade does, for the guard tests that check colour values
 * (`theme-contrast.test.ts`, `../lib/theme-swatches.test.ts`).
 *
 * Kept in one place because both tests have to layer the blocks identically:
 * a token map built in a different order answers a different question, and
 * the two would then disagree about what the app renders.
 */

// Read off disk rather than via import.meta.glob with `?raw`: Vitest's CSS
// handling intercepts .css modules and hands back an empty string, which
// would let every check pass over an empty token set.
export const themesCss = readFileSync(resolve(process.cwd(), 'src/app/themes.css'), 'utf8');
export const globalsCss = readFileSync(resolve(process.cwd(), 'src/app/globals.css'), 'utf8');

const srgbToLinear = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

export type Decls = Record<string, string>;
export type Mode = 'light' | 'dark';

/**
 * Stock Tailwind v4 values as sRGB hex, for the tokens the checks read. The
 * default palette is the only consumer -- every other theme overrides these.
 * Risk: a Tailwind upgrade that retunes its oklch ramp would drift from this
 * fixture, leaving the default theme's checks off by that drift.
 */
export const STOCK: Decls = {
  '--color-white': '#ffffff',
  '--color-gray-50': '#f9fafb',
  '--color-gray-100': '#f3f4f6',
  '--color-gray-200': '#e5e7eb',
  '--color-gray-300': '#d1d5db',
  '--color-gray-400': '#99a1af',
  '--color-gray-500': '#6a7282',
  '--color-gray-600': '#4a5565',
  '--color-gray-700': '#364153',
  '--color-gray-800': '#1e2939',
  '--color-gray-900': '#101828',
  '--color-gray-950': '#030712',
  '--color-blue-400': '#51a2ff',
  '--color-blue-500': '#2b7fff',
  '--color-blue-600': '#155dfc',
};

function parseDecls(body: string): Decls {
  const decls: Decls = {};
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls[match[1]] = match[2].trim();
  }
  return decls;
}

/** `html[data-theme='x']` and `html.dark[data-theme='x']` blocks. */
function parseThemeBlocks(css: string): { light: Map<string, Decls>; dark: Map<string, Decls> } {
  const light = new Map<string, Decls>();
  const dark = new Map<string, Decls>();
  for (const match of css.matchAll(/html(\.dark)?\[data-theme='([a-z]+)'\]\s*\{([^}]*)\}/g)) {
    (match[1] ? dark : light).set(match[2], parseDecls(match[3]));
  }
  return { light, dark };
}

/**
 * Merged `:root` and `.dark` declarations. The selector must be exactly
 * `:root`/`.dark`: a descendant selector like `.dark body` is surface
 * styling, not a token definition.
 */
function parseGlobals(css: string): { root: Decls; dark: Decls } {
  const root: Decls = {};
  const dark: Decls = {};
  for (const match of css.matchAll(/(?:^|\n)(:root|\.dark)\s*\{([^}]*)\}/g)) {
    Object.assign(match[1] === ':root' ? root : dark, parseDecls(match[2]));
  }
  return { root, dark };
}

export const themeBlocks = parseThemeBlocks(themesCss);
export const globals = parseGlobals(globalsCss);

/**
 * Every custom property in effect for a theme in a mode, layered in cascade
 * order: stock Tailwind, globals `:root`, globals `.dark`, the theme's light
 * block -- whose specificity (0,1,1) beats `.dark` (0,1,0), which is why a
 * theme overriding chart tokens needs its own dark block -- then that dark
 * block (0,2,1).
 */
export function themeTokens(theme: string, mode: Mode): Decls {
  return {
    ...STOCK,
    ...globals.root,
    ...(mode === 'dark' ? globals.dark : {}),
    ...(themeBlocks.light.get(theme) ?? {}),
    ...(mode === 'dark' ? (themeBlocks.dark.get(theme) ?? {}) : {}),
  };
}

/** Follow `var(...)` indirection to the literal hex a token ends at. */
export function resolveHex(decls: Decls, name: string): string {
  let value = decls[name];
  for (let i = 0; i < 10 && value; i += 1) {
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (!ref) break;
    value = decls[ref[1]];
  }
  if (!value || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(
      `Cannot resolve ${name} to a 6-digit hex (got ${JSON.stringify(value)}). ` +
        'Extend the STOCK fixture or fix the token.',
    );
  }
  return value.toLowerCase();
}

type Oklab = [number, number, number];

function toOklab(hex: string): Oklab {
  const [r, g, b] = [1, 3, 5].map((i) =>
    srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255),
  );
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/**
 * Perceptual distance between two colours, for "do these read as the same?".
 * OKLab is near-uniform, so a plain Euclidean distance in it corresponds to
 * how different two colours actually look -- which comparing hex strings, or
 * even comparing hue angles, does not.
 */
export function oklabDistance(a: string, b: string): number {
  const x = toOklab(a);
  const y = toOklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
