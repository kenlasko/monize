import { THEME_SWATCHES } from '@/lib/theme-swatches';

/**
 * Whether a brand logo needs a fill behind it to stay visible.
 *
 * - `none`: the logo paints its own background, or its ink already stands out
 *   against the card in both modes.
 * - `light`: dark ink on transparency, lost on a dark card; filled light in
 *   dark mode only.
 * - `dark`: light ink on transparency, lost on a light card; filled dark in
 *   light mode only.
 */
export type LogoBacking = 'none' | 'light' | 'dark';

/** Side, in pixels, of the square a logo is redrawn at before it is read. */
export const LOGO_SAMPLE_SIZE = 32;

/**
 * Below this share of see-through pixels inside the round chip, the logo
 * brings its own background and is left alone.
 */
const TRANSPARENT_SHARE = 0.15;

/**
 * Contrast ratio (WCAG) between the logo's dominant colour and the card below
 * which a fill is added. Lower than the 3:1 non-text floor on purpose: a brand
 * colour such as orange on white is legible, only a near-match is not.
 */
const MIN_CONTRAST = 2;

/** An alpha at or above this counts as ink; at or below `CLEAR_ALPHA`, as see-through. */
const INK_ALPHA = 128;
const CLEAR_ALPHA = 16;

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * channelToLinear(r) + 0.7152 * channelToLinear(g) + 0.0722 * channelToLinear(b)
  );
}

function hexLuminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return relativeLuminance((value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff);
}

function contrastRatio(a: number, b: number): number {
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// The default palette's cards. Every palette's light card is a near-white paper
// and its dark card a near-black one, so one pair stands for all of them.
const LIGHT_CARD_LUMINANCE = hexLuminance(THEME_SWATCHES.default.light.card);
const DARK_CARD_LUMINANCE = hexLuminance(THEME_SWATCHES.default.dark.card);

/**
 * Decide the backing from a logo's RGBA pixels, `size` x `size`, row-major.
 *
 * Only the inscribed circle is read, because that is what the round chip
 * shows. The dominant colour is the most populated bucket of ink pixels
 * (3 bits per channel), averaged over its members.
 */
export function classifyLogoPixels(data: ArrayLike<number>, size: number): LogoBacking {
  const radius = size / 2;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  let inCircle = 0;
  let clear = 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x + 0.5 - radius;
      const dy = y + 0.5 - radius;
      if (dx * dx + dy * dy > radius * radius) continue;
      inCircle += 1;

      const offset = (y * size + x) * 4;
      const alpha = data[offset + 3];
      if (alpha <= CLEAR_ALPHA) {
        clear += 1;
        continue;
      }
      if (alpha < INK_ALPHA) continue;

      const r = data[offset];
      const g = data[offset + 1];
      const b = data[offset + 2];
      const key = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.count += 1;
        bucket.r += r;
        bucket.g += g;
        bucket.b += b;
      } else {
        buckets.set(key, { count: 1, r, g, b });
      }
    }
  }

  if (inCircle === 0 || clear / inCircle < TRANSPARENT_SHARE) return 'none';

  let dominant: { count: number; r: number; g: number; b: number } | null = null;
  for (const bucket of buckets.values()) {
    if (!dominant || bucket.count > dominant.count) dominant = bucket;
  }
  if (!dominant) return 'none';

  const ink = relativeLuminance(
    dominant.r / dominant.count,
    dominant.g / dominant.count,
    dominant.b / dominant.count,
  );
  if (contrastRatio(ink, DARK_CARD_LUMINANCE) < MIN_CONTRAST) return 'light';
  if (contrastRatio(ink, LIGHT_CARD_LUMINANCE) < MIN_CONTRAST) return 'dark';
  return 'none';
}

/**
 * Redraw a loaded logo small and read its pixels; null where the browser
 * cannot (no 2D canvas, or an image it refuses to expose). The logo is served
 * from our own origin, so the canvas is not tainted.
 */
let sampleContext: CanvasRenderingContext2D | null = null;

function sampleLogo(image: HTMLImageElement): Uint8ClampedArray | null {
  try {
    if (!sampleContext) {
      const canvas = document.createElement('canvas');
      canvas.width = LOGO_SAMPLE_SIZE;
      canvas.height = LOGO_SAMPLE_SIZE;
      sampleContext = canvas.getContext('2d', { willReadFrequently: true });
    }
    const context = sampleContext;
    if (!context) return null;
    context.clearRect(0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE);
    context.drawImage(image, 0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE);
    return context.getImageData(0, 0, LOGO_SAMPLE_SIZE, LOGO_SAMPLE_SIZE).data;
  } catch {
    return null;
  }
}

// The last answer per logo URL, so a remount shows its fill on the first paint
// instead of after the load. Every load still re-reads the pixels: a payee's
// logo is refetched under the same URL when its website changes.
const backingByUrl = new Map<string, LogoBacking>();

/** The backing already worked out for this URL, if any. */
export function cachedLogoBacking(src: string | null): LogoBacking | undefined {
  return src ? backingByUrl.get(src) : undefined;
}

/**
 * The backing for a logo that has just loaded. A logo that cannot be read
 * keeps no fill, which is how every logo rendered before this existed.
 */
export function logoBackingFor(src: string, image: HTMLImageElement): LogoBacking {
  const pixels = sampleLogo(image);
  const backing = pixels ? classifyLogoPixels(pixels, LOGO_SAMPLE_SIZE) : 'none';
  backingByUrl.set(src, backing);
  return backing;
}

/** Test seam: forget every cached answer and the canvas they were read with. */
export function clearLogoBackingCache(): void {
  backingByUrl.clear();
  sampleContext = null;
}
