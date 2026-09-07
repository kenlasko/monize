import type { Point, Quad, RawImage } from './document-scan.types';

/**
 * A generated photograph of a document, with the corners known in advance.
 *
 * The pipeline's job is to find four corners and flatten them, so a fixture is
 * only evidence if the answer is known independently of the code being tested.
 * Drawing the page ourselves gives exactly that: the planted quad is the truth,
 * and detection either lands near it or does not.
 *
 * Also used by the end-to-end spec, so the browser exercises the same picture
 * the unit tests calibrate against.
 */

export interface SyntheticOptions {
  width?: number;
  height?: number;
  /** The page's corners. Defaults to a plausibly skewed rectangle. */
  quad?: Quad;
  /** Page brightness, 0-255. */
  paper?: number;
  /** Background brightness, 0-255. */
  background?: number;
  /** Draw lines of text on the page, so sharpness is measurable. */
  text?: boolean;
  /** Box-blur radius, to simulate a photo taken while moving. */
  blurRadius?: number;
  /**
   * Darken one side by up to this fraction, as a hand's shadow would.
   * 0 is even lighting.
   */
  shadow?: number;
}

/** A skewed page, off-centre and rotated, as a hand-held photo gives. */
export const DEFAULT_QUAD: Quad = [
  { x: 140, y: 90 },
  { x: 620, y: 150 },
  { x: 580, y: 640 },
  { x: 100, y: 560 },
];

/** How far printed lines stay clear of the page's own edge, in pixels. */
const TEXT_MARGIN = 24;

/** Whether a point is inside a convex quad (all cross products share a sign). */
function insideQuad(point: Point, quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const cross = (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x);
    if (cross === 0) continue;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

/** Render the fixture as RGBA pixels. */
export function syntheticDocument(options: SyntheticOptions = {}): RawImage {
  const {
    width = 720,
    height = 720,
    quad = DEFAULT_QUAD,
    paper = 240,
    background = 40,
    text = true,
    blurRadius = 0,
    shadow = 0,
  } = options;

  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = insideQuad({ x, y }, quad);
      let value = inside ? paper : background;

      if (inside && text) {
        // Horizontal rules standing in for lines of print: dark, thin, and
        // regular, which is what a sharpness measure keys on.
        //
        // The margin is measured against the page ITSELF at this row, not
        // against a fixed pair of x values: the page is skewed, so a fixed
        // margin taken from the top corners lets the lower lines run past the
        // edge. Dark text meeting the dark background erases the outline
        // exactly where detection looks for it, and the fixture then tests a
        // page with no findable border.
        const withinLine = y % 24 < 3;
        const clearOfEdge =
          insideQuad({ x: x - TEXT_MARGIN, y }, quad) &&
          insideQuad({ x: x + TEXT_MARGIN, y }, quad) &&
          insideQuad({ x, y: y - TEXT_MARGIN }, quad) &&
          insideQuad({ x, y: y + TEXT_MARGIN }, quad);
        if (withinLine && clearOfEdge) value = 30;
      }

      if (inside && shadow > 0) {
        // A gradient across the page, strongest at the left edge.
        const falloff = 1 - shadow * (1 - x / width);
        value = Math.round(value * falloff);
      }

      const offset = (y * width + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }

  const image: RawImage = { width, height, data };
  return blurRadius > 0 ? boxBlur(image, blurRadius) : image;
}

/**
 * A separable box blur.
 *
 * Deliberately not a Gaussian: the fixture only has to destroy high-frequency
 * detail convincingly, and a box blur does that with arithmetic a reader can
 * check by eye.
 */
export function boxBlur(image: RawImage, radius: number): RawImage {
  const { width, height, data } = image;
  const horizontal = new Uint8ClampedArray(data.length);
  const output = new Uint8ClampedArray(data.length);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const sx = x + k;
        if (sx < 0 || sx >= width) continue;
        total += data[(y * width + sx) * 4];
        count++;
      }
      const value = total / count;
      const offset = (y * width + x) * 4;
      horizontal[offset] = value;
      horizontal[offset + 1] = value;
      horizontal[offset + 2] = value;
      horizontal[offset + 3] = 255;
    }
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let total = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const sy = y + k;
        if (sy < 0 || sy >= height) continue;
        total += horizontal[(sy * width + x) * 4];
        count++;
      }
      const value = total / count;
      const offset = (y * width + x) * 4;
      output[offset] = value;
      output[offset + 1] = value;
      output[offset + 2] = value;
      output[offset + 3] = 255;
    }
  }

  return { width, height, data: output };
}

/** A frame with no document in it at all, for the not-found path. */
export function blankFrame(width = 400, height = 400, value = 128): RawImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = value;
    data[i * 4 + 1] = value;
    data[i * 4 + 2] = value;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}
