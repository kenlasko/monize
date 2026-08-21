#!/usr/bin/env node
/**
 * Generate the gray ramp for each colour theme in src/app/themes.css.
 *
 * Why: the ramp is the theme. Cards, pages, borders and most text all read
 * from it, so it covers nearly every pixel -- while the accent ramp covers
 * buttons, links and chart series, which is a small fraction of the screen.
 * A theme whose ramp is near-neutral therefore looks like every other
 * near-neutral theme no matter how distinct its accent is, which is exactly
 * what the first pass at this got wrong: it tinted `--color-white` by one or
 * two percent and left the rest of the ramp grey.
 *
 * The measured evidence: gruvbox, the one palette that reliably read as its
 * own theme, carried a card chroma of 0.055; burgundy, forest, nord,
 * dracula and tokyonight sat between 0.003 and 0.007. This script puts every
 * theme at gruvbox's order of magnitude.
 *
 * How it works: lightness comes from one shared curve (below) and chroma
 * from one shared profile, so every theme separates page from card from
 * border by the same amount and only the HUE distinguishes them. That is
 * what keeps fifteen bolder palettes from becoming fifteen different
 * legibility problems -- contrast is a property of the curve, which is
 * checked once, rather than of each hand-picked value.
 *
 * Themes deliberately absent: `default` (stock Tailwind identity),
 * `midnight` (a neutral black AMOLED palette by design) and `highcontrast`,
 * whose whole point is maximum luminance contrast -- chroma on those surfaces
 * spends exactly the budget the theme exists to protect. `colorblind` IS
 * generated: its guarantee is about the chart palette, not the chrome.
 *
 * Usage: node scripts/derive-theme-ramp.mjs
 * Output is literal 6-digit hex, which resolvePdfColor requires.
 */

/**
 * Lightness per ramp step, shared by every theme.
 *
 * One curve has to serve both modes, because light mode reads the 50-300 end
 * for surfaces and dark mode the 700-950 end:
 *   light: white = card, 50 = page, 200 = border, 500 = muted text, 900 = body
 *   dark:  800 = card, 900 = page, 700 = border, 400 = muted text, 100 = body
 * So `white` sits above `50` (card lifts off the page), and 700 > 800 > 900
 * (border lifts off the card, card lifts off the page) -- the dark-mode
 * separation that several themes previously lacked.
 */
const LIGHTNESS = {
  white: 0.950,
  50: 0.912,
  100: 0.875,
  200: 0.825,
  300: 0.755,
  400: 0.672,
  500: 0.520,
  600: 0.442,
  700: 0.394,
  800: 0.293,
  900: 0.222,
  950: 0.168,
};

/**
 * Chroma ceiling per ramp step, shared by every theme.
 *
 * This is a cap, not a target: the value actually used is the lesser of this
 * and a fixed share of what the hue can hold at that lightness (see
 * `chromaFor`). sRGB is drastically asymmetric near white -- at L 0.95 a
 * green can carry 0.10 chroma while a blue tops out near 0.024 -- so a flat
 * target tints the warm themes several times harder than the cool ones and
 * leaves exactly the palettes that looked interchangeable still looking
 * interchangeable. Taking a share of the available gamut instead spends each
 * hue's real headroom, and the cap stops the roomy hues going lurid.
 */
const CHROMA_CAP = {
  white: 0.046,
  50: 0.058,
  100: 0.064,
  200: 0.070,
  300: 0.072,
  400: 0.068,
  500: 0.062,
  600: 0.060,
  700: 0.058,
  800: 0.054,
  900: 0.048,
  950: 0.040,
};

/** Share of the hue's in-gamut chroma to spend at each step. */
const GAMUT_SHARE = 0.9;

/**
 * Per-theme identity: hue at each end of the ramp, and how hard to tint.
 *
 * `intensity` scales the chroma profile, and it matters as much as hue.
 * A first pass varied only the hue, which flattened every palette into "the
 * same theme at a different angle" and had two visible costs. Themes whose
 * hues sit close became indistinguishable -- latte, gruvbox, solarized and
 * MS Money were crammed into twelve degrees of cream. And a theme whose
 * character WAS its intensity lost it: MS Money is pale parchment with navy
 * text and a deep green accent, so rendering it as saturated butter made it
 * a yellow theme wearing MS Money's accent.
 *
 * Cream and parchment is a crowded, legitimate family, and hue alone cannot
 * separate its members -- they genuinely occupy the same arc. What separates
 * them is how strongly the paper is tinted, where the ramp's dark end goes,
 * and the accent. So the four warm themes sit at four intensities (pale
 * ivory, warm cream, soft wheat, rich butter) and run to four different
 * darks (navy, taupe, teal, brown).
 *
 * Hues are spread so no two themes sit within ~20 degrees at a comparable
 * intensity; where they are closer than that, the intensities differ enough
 * that the papers do not read alike.
 */
const THEMES = {
  // -- the cream/parchment family, separated by intensity and by dark end --
  msmoney: {
    light: 84,
    dark: 250,
    intensity: 0.32,
    note: 'pale parchment over Money navy -- the palest of the warm papers',
  },
  latte: { light: 70, dark: 58, intensity: 0.82, note: 'warm caramel cream over taupe' },
  solarized: { light: 118, dark: 200, intensity: 0.68, note: 'soft wheat base3 over base03 teal' },
  gruvbox: { light: 94, dark: 74, intensity: 1.15, note: 'rich retro butter, the most saturated paper' },

  // -- warm reds, spread apart so salmon and wine do not meet --
  // Reds run out of gamut near white sooner than yellows do, so these carry
  // a higher intensity to land at a comparable tint.
  newspaper: { light: 42, dark: 268, intensity: 0.95, note: 'FT salmon paper over navy slate' },
  burgundy: { light: 12, dark: 4, intensity: 1.0, note: 'rose paper deepening into wine' },
  rosepine: { light: 337, dark: 295, intensity: 0.75, note: 'dawn rose over main iris' },

  // -- greens and cools --
  forest: { light: 148, dark: 152, intensity: 0.85, note: 'green paper over forest darks' },
  nord: { light: 245, dark: 258, intensity: 1.0, note: 'arctic blue-grey throughout' },
  tokyonight: { light: 275, dark: 283, intensity: 0.95, note: 'indigo throughout' },
  dracula: { light: 303, dark: 296, intensity: 0.9, note: 'violet throughout' },

  // The CVD-safe theme keeps its Okabe-Ito CHART palette untouched -- that is
  // the accessibility guarantee -- but its surfaces are not data, so tinting
  // them costs no CVD budget and nothing in the guarantee. Leaving them stock
  // made it byte-identical to `default` everywhere except a chart: every grey
  // token matched, and the dark link accent differed by 0.069. Low intensity
  // and a hue in the wide gap between forest and nord, so it reads as cool
  // grey rather than as a second blue theme beside nord.
  colorblind: { light: 205, dark: 212, intensity: 0.5, note: 'cool neutral grey, Okabe-Ito charts' },
};

const STEPS = ['white', 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/**
 * How far through the ramp a step sits, for interpolating the hue.
 *
 * The shift is deliberately concentrated in the 400-700 band rather than
 * spread evenly: a theme like MS Money is parchment *or* navy, and a ramp
 * that eases between them across every step spends half its range on
 * intermediate hues belonging to neither. Holding each end flat keeps the
 * surfaces on the hue the theme is actually named for.
 */
const HUE_POSITION = {
  white: 0,
  50: 0,
  100: 0,
  200: 0,
  300: 0.05,
  400: 0.15,
  500: 0.4,
  600: 0.7,
  700: 0.9,
  800: 1,
  900: 1,
  950: 1,
};

/**
 * Chroma damping through a wide hue shift.
 *
 * Interpolating between two distant hues passes through a third the theme
 * never chose -- parchment to navy crosses green. Damping chroma where the
 * crossing happens keeps those steps reading as neutral transitions instead
 * of as a colour nobody designed. A single-hue theme shifts by nothing and
 * is therefore undamped.
 */
function chromaDamp(hueDelta, t) {
  const span = Math.min(Math.abs(hueDelta), 180) / 180;
  return 1 - 0.45 * Math.sin(Math.PI * t) * span;
}

const linearToSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);

function oklchToRgb(L, C, hueDeg) {
  const H = (hueDeg * Math.PI) / 180;
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

/** The most chroma this hue can hold at this lightness in sRGB. */
function maxChroma(L, H) {
  let c = 0;
  while (c < 0.4 && inGamut(oklchToRgb(L, c + 0.002, H))) c += 0.002;
  return c;
}

/**
 * The lesser of the step's cap and a fixed share of the available gamut,
 * scaled by the theme's own intensity.
 */
function chromaFor(step, L, H, intensity) {
  return Math.min(CHROMA_CAP[step], GAMUT_SHARE * maxChroma(L, H)) * intensity;
}

/** Back off chroma until the colour is representable in sRGB. */
function toHex(L, C, H) {
  let chroma = C;
  let rgb = oklchToRgb(L, chroma, H);
  while (!inGamut(rgb) && chroma > 0.001) {
    chroma -= 0.002;
    rgb = oklchToRgb(L, chroma, H);
  }
  return (
    '#' +
    rgb
      .map((c) => Math.max(0, Math.min(255, Math.round(c * 255))).toString(16).padStart(2, '0'))
      .join('')
  );
}

/** Shortest-path interpolation around the hue circle. */
function mixHue(a, b, t) {
  let delta = ((b - a + 540) % 360) - 180;
  return (a + delta * t + 360) % 360;
}

const lines = [];
for (const [name, cfg] of Object.entries(THEMES)) {
  lines.push(`/* ${name}: ${cfg.note} */`);
  for (const step of STEPS) {
    const t = HUE_POSITION[step];
    const hue = mixHue(cfg.light, cfg.dark, t);
    const delta = ((cfg.dark - cfg.light + 540) % 360) - 180;
    const base = chromaFor(step, LIGHTNESS[step], hue, cfg.intensity);
    const hex = toHex(LIGHTNESS[step], base * chromaDamp(delta, t), hue);
    const token = step === 'white' ? '--color-white' : `--color-gray-${step}`;
    lines.push(`  ${token}: ${hex};`);
  }
  // The dark-mode table stripe sits between the card (800) and page (900).
  const stripeL = (LIGHTNESS[800] + LIGHTNESS[900]) / 2;
  lines.push(
    `  --color-table-stripe-dark: ${toHex(stripeL, chromaFor(900, stripeL, cfg.dark, cfg.intensity), cfg.dark)};`,
  );
  lines.push('');
}

process.stdout.write(lines.join('\n'));
