#!/usr/bin/env node
/**
 * Generate the `html.dark[data-theme='...']` chart/accent palette blocks for
 * src/app/themes.css.
 *
 * Why this exists: every non-default theme overrides `--chart-*` (and the blue
 * accent ramp) in its light `html[data-theme]` block, whose specificity
 * (0,1,1) beats the `.dark` defaults in globals.css (0,1,0). So without a
 * per-theme `html.dark[data-theme]` block, dark mode renders the light-tuned
 * chart colors -- values picked to sit on white paper -- on a dark card,
 * which is what "washed out" looks like. This script derives a dark variant
 * of each palette: same hue, lightness lifted until the color clears a
 * contrast target against the theme's dark card surface.
 *
 * Two derivation modes:
 *  - `upstream`: the theme has a canonical dark palette (nord, dracula,
 *    gruvbox, solarized, tokyonight, rosepine). Start from those values and
 *    lift lightness only where the canonical color misses the target.
 *  - `derive`: the palette was invented for this app (latte, msmoney,
 *    newspaper, burgundy, forest). Start from the light values, floor
 *    lightness at MIN_L, cap chroma at MAX_C so the lift does not turn
 *    saturated paper colors garish, then lift further if still short.
 *  - `colorblind` uses `upstream` semantics (lift only, no chroma cap) so the
 *    Okabe-Ito hue separations survive; only lightness moves.
 *
 * The output is pasted into themes.css and hand-reviewed. The invariant
 * itself is held by src/test/theme-contrast.test.ts, which measures the CSS
 * that actually ships -- this script is a generator, not an authority.
 *
 * Usage: node scripts/derive-dark-palette.mjs
 * All output values are literal 6-digit hex: resolvePdfColor
 * (src/components/reports/resolve-pdf-color.ts) rejects anything else.
 */

const CHART_TARGET = 3.2; // test asserts >= 3.0; derive with margin
const LINK_TARGET = 4.7; // blue-400 as dark link text; test asserts >= 4.5
const MIN_L = 0.7;
const MAX_C = 0.15;

// ---------- color math ----------

function hexToRgb(hex) {
  const v = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16) / 255);
}

function rgbToHex(rgb) {
  return (
    '#' +
    rgb
      .map((c) => {
        const v = Math.max(0, Math.min(255, Math.round(c * 255)));
        return v.toString(16).padStart(2, '0');
      })
      .join('')
  );
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function rgbToOklch(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(a, bb), H: Math.atan2(bb, a) };
}

function oklchToRgb({ L, C, H }) {
  const a = C * Math.cos(H);
  const b = C * Math.sin(H);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map(linearToSrgb);
}

const inGamut = (rgb) => rgb.every((c) => c >= -1e-4 && c <= 1 + 1e-4);

/** Reduce chroma just enough to bring an out-of-gamut color back inside. */
function toGamut(lch) {
  let { L, C, H } = lch;
  let rgb = oklchToRgb({ L, C, H });
  while (!inGamut(rgb) && C > 0.001) {
    C -= 0.002;
    rgb = oklchToRgb({ L, C, H });
  }
  return rgb.map((c) => Math.max(0, Math.min(1, c)));
}

function wcagLuminance(rgb) {
  const [r, g, b] = rgb.map(srgbToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hexA, hexB) {
  const la = wcagLuminance(hexToRgb(hexA));
  const lb = wcagLuminance(hexToRgb(hexB));
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Lift a color's lightness until it clears `target` contrast against `card`.
 * `derive` mode additionally floors L and caps C before lifting.
 */
function lift(hex, card, target, mode) {
  let lch = rgbToOklch(hexToRgb(hex));
  if (mode === 'derive') {
    lch = { ...lch, L: Math.max(lch.L, MIN_L), C: Math.min(lch.C, MAX_C) };
  }
  for (let i = 0; i < 200; i += 1) {
    const out = rgbToHex(toGamut(lch));
    if (contrast(out, card) >= target || lch.L >= 0.97) return out;
    lch = { ...lch, L: lch.L + 0.0025 };
  }
  return rgbToHex(toGamut(lch));
}

// ---------- per-theme configuration ----------

// `card` is the theme's dark-mode gray-800 AFTER the surface retune this
// branch applies (see the html.dark blocks in themes.css). `charts` are the
// starting values per the mode described above; `blue400` is the theme's
// light blue-400, lifted here only when it misses LINK_TARGET on the card.
const THEMES = {
  latte: {
    mode: 'derive',
    card: '#352d24',
    blue400: '#c28f4c',
    charts: {
      income: '#6f9b54',
      expense: '#c65d4a',
      warning: '#c99a3c',
      1: '#aa7634',
      2: '#6f9b54',
      3: '#c99a3c',
      4: '#c65d4a',
      5: '#8d7aa5',
      6: '#b56a8d',
      7: '#5e8e8a',
      8: '#97a04c',
      9: '#c97f3e',
      10: '#7d6b9e',
    },
  },
  msmoney: {
    mode: 'derive',
    card: '#243646',
    blue400: '#58966a',
    charts: {
      income: '#3a7d4f',
      expense: '#a23b3b',
      warning: '#b08a3e',
      1: '#3a7d4f',
      2: '#2c4a6e',
      3: '#b08a3e',
      4: '#a23b3b',
      5: '#3f7d7d',
      6: '#6e4a7d',
      7: '#a85c32',
      8: '#7d7d3b',
      9: '#5a7d9e',
      10: '#5c7d4a',
    },
  },
  newspaper: {
    mode: 'derive',
    card: '#33363f',
    blue400: '#d44d7a',
    charts: {
      income: '#00824c',
      expense: '#cc0000',
      warning: '#cf8a00',
      1: '#0f5499',
      2: '#00824c',
      3: '#cf8a00',
      4: '#990f3d',
      5: '#593380',
      6: '#0d7680',
      7: '#cc5a2a',
      8: '#96cc28',
      9: '#c4577e',
      10: '#66605c',
    },
  },
  burgundy: {
    mode: 'derive',
    card: '#2e2a28',
    blue400: '#cd5a6e',
    charts: {
      income: '#2e7d4f',
      expense: '#c44528',
      warning: '#c9882e',
      1: '#b03a52',
      2: '#2e7d4f',
      3: '#c9882e',
      4: '#cd5a3e',
      5: '#5b6e9e',
      6: '#3f7d80',
      7: '#8a6d3b',
      8: '#7d5a8c',
      9: '#2f5d8a',
      10: '#6e6259',
    },
  },
  forest: {
    mode: 'derive',
    card: '#292524',
    blue400: '#57a578',
    charts: {
      income: '#378758',
      expense: '#b5543d',
      warning: '#c9892e',
      1: '#378758',
      2: '#4f7d8c',
      3: '#c9892e',
      4: '#b5543d',
      5: '#7a5c8f',
      6: '#8f9a3d',
      7: '#57a578',
      8: '#8c6d4f',
      9: '#356b5e',
      10: '#a08a4f',
    },
  },
  nord: {
    mode: 'upstream',
    card: '#3b4252',
    blue400: '#88c0d0',
    charts: {
      income: '#a3be8c',
      expense: '#bf616a',
      warning: '#ebcb8b',
      1: '#88c0d0',
      2: '#a3be8c',
      3: '#ebcb8b',
      4: '#bf616a',
      5: '#b48ead',
      6: '#8fbcbb',
      7: '#d08770',
      8: '#81a1c1',
      9: '#5e81ac',
      10: '#d8dee9',
    },
  },
  solarized: {
    mode: 'upstream',
    card: '#073642',
    blue400: '#449bd9',
    charts: {
      income: '#859900',
      expense: '#dc322f',
      warning: '#b58900',
      1: '#268bd2',
      2: '#859900',
      3: '#b58900',
      4: '#dc322f',
      5: '#6c71c4',
      6: '#2aa198',
      7: '#cb4b16',
      8: '#d33682',
      9: '#93a1a1',
      10: '#586e75',
    },
  },
  gruvbox: {
    mode: 'upstream',
    card: '#32302f',
    blue400: '#e57d2a',
    charts: {
      income: '#b8bb26',
      expense: '#fb4934',
      warning: '#fabd2f',
      1: '#fe8019',
      2: '#b8bb26',
      3: '#fabd2f',
      4: '#fb4934',
      5: '#d3869b',
      6: '#83a598',
      7: '#8ec07c',
      8: '#d65d0e',
      9: '#b16286',
      10: '#a89984',
    },
  },
  dracula: {
    mode: 'upstream',
    card: '#2b2d3d',
    blue400: '#bd93f9',
    charts: {
      income: '#50fa7b',
      expense: '#ff5555',
      warning: '#f1fa8c',
      1: '#bd93f9',
      2: '#50fa7b',
      3: '#f1fa8c',
      4: '#ff5555',
      5: '#ff79c6',
      6: '#8be9fd',
      7: '#ffb86c',
      8: '#38b6d8',
      9: '#d6acff',
      10: '#6272a4',
    },
  },
  tokyonight: {
    mode: 'upstream',
    card: '#24283b',
    blue400: '#7aa2f7',
    charts: {
      income: '#9ece6a',
      expense: '#f7768e',
      warning: '#e0af68',
      1: '#7aa2f7',
      2: '#9ece6a',
      3: '#e0af68',
      4: '#f7768e',
      5: '#bb9af7',
      6: '#7dcfff',
      7: '#ff9e64',
      8: '#73daca',
      9: '#9d7cd8',
      10: '#a9b1d6',
    },
  },
  rosepine: {
    mode: 'upstream',
    card: '#1f1d2e',
    blue400: '#56949f',
    charts: {
      income: '#9ccfd8',
      expense: '#eb6f92',
      warning: '#f6c177',
      1: '#31748f',
      2: '#ebbcba',
      3: '#f6c177',
      4: '#eb6f92',
      5: '#c4a7e7',
      6: '#9ccfd8',
      7: '#d7827e',
      8: '#ea9d34',
      9: '#907aa9',
      10: '#908caa',
    },
  },
  colorblind: {
    mode: 'upstream',
    card: '#1e2939',
    blue400: '#3a92cc',
    charts: {
      income: '#0072b2',
      expense: '#d55e00',
      warning: '#e69f00',
      1: '#0072b2',
      2: '#009e73',
      3: '#e69f00',
      4: '#d55e00',
      5: '#cc79a7',
      6: '#56b4e9',
      7: '#f0e442',
      8: '#785ef0',
      9: '#919191',
      10: '#117733',
    },
  },
};

// ---------- output ----------

const lines = [];
for (const [name, cfg] of Object.entries(THEMES)) {
  lines.push(`html.dark[data-theme='${name}'] {`);
  const blue400 = lift(cfg.blue400, cfg.card, LINK_TARGET, cfg.mode);
  if (blue400.toLowerCase() !== cfg.blue400.toLowerCase()) {
    lines.push(`  --color-blue-400: ${blue400};`);
    lines.push('');
  }
  for (const key of ['income', 'expense', 'warning', 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const value = lift(cfg.charts[key], cfg.card, CHART_TARGET, cfg.mode);
    lines.push(`  --chart-${key}: ${value};`);
  }
  lines.push('}');
  lines.push('');
}

process.stdout.write(lines.join('\n'));
