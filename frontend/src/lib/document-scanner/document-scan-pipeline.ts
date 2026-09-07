import type { OpenCv } from './opencv-engine';
import {
  DETECT_MAX_EDGE,
  MIN_DOCUMENT_AREA_RATIO,
  OUTPUT_MAX_EDGE,
  fitScale,
  fullFrameQuad,
  isConvexQuad,
  orderCorners,
  outputSize,
  quadArea,
  scaleQuad,
} from './document-scan-geometry';
import type { Point, Quad, RawImage } from './document-scan.types';

/**
 * The image operations, in the order Discussion #1292 lays them out: find the
 * document, correct its perspective, even out the lighting, then sharpen.
 *
 * Every constant is named here rather than inlined, because these are the
 * numbers somebody will need to retune against real photographs, and a
 * magic `2.0` three calls deep is not tunable. The geometry the steps depend on
 * lives in `document-scan-geometry.ts`, so this file is only the pixels.
 *
 * `cv` is a parameter rather than an import: it keeps the OpenCV import in one
 * module (`I7`), and it makes each step callable from a test that supplies the
 * real engine without this file deciding when the engine loads.
 */

/** Gaussian blur kernel used to quiet sensor noise before edge detection. */
const DETECT_BLUR_KERNEL = 5;
/** Canny thresholds, as fractions of the working image's median intensity. */
const CANNY_LOW_RATIO = 0.66;
const CANNY_HIGH_RATIO = 1.33;
/** Dilation that closes the small gaps a printed border leaves in an edge map. */
const EDGE_DILATE_KERNEL = 3;
/** How closely a contour must match a quadrilateral, as a share of perimeter. */
const POLY_EPSILON_RATIO = 0.02;

/** Kernel of the morphological close that estimates the page's illumination. */
const ILLUMINATION_KERNEL = 31;
/** CLAHE parameters for local contrast, applied to lightness only. */
const CLAHE_CLIP_LIMIT = 2.0;
const CLAHE_TILE = 8;
/** Bilateral filter: smooths paper grain while keeping glyph edges crisp. */
const DENOISE_DIAMETER = 5;
const DENOISE_SIGMA_COLOR = 50;
const DENOISE_SIGMA_SPACE = 50;
/** Unsharp mask strength. */
const SHARPEN_SIGMA = 1;
const SHARPEN_AMOUNT = 0.6;

/** Everything allocated inside one step, released even when a step throws. */
class Scope {
  private readonly items: { delete(): void }[] = [];

  add<T extends { delete(): void }>(item: T): T {
    this.items.push(item);
    return item;
  }

  release(): void {
    // Reverse order, so a Mat built from another is freed first.
    for (const item of this.items.reverse()) {
      try {
        item.delete();
      } catch {
        // A double delete is not worth failing a scan over; the runtime's heap
        // is discarded with the worker anyway.
      }
    }
    this.items.length = 0;
  }
}

/** Wrap OpenCV work so its Mats are freed on every path. */
function withScope<T>(fn: (scope: Scope) => T): T {
  const scope = new Scope();
  try {
    return fn(scope);
  } finally {
    scope.release();
  }
}

/** Build a Mat from a decoded image. */
function toMat(cv: OpenCv, image: RawImage): InstanceType<OpenCv['Mat']> {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(image.data);
  return mat;
}

/** Copy a Mat back out as plain transferable data. */
function toRawImage(mat: {
  rows: number;
  cols: number;
  data: Uint8Array;
}): RawImage {
  return {
    width: mat.cols,
    height: mat.rows,
    data: new Uint8ClampedArray(mat.data),
  };
}

/** The median intensity of a single-channel Mat, for adaptive Canny bounds. */
function medianIntensity(gray: { data: Uint8Array }): number {
  const histogram = new Uint32Array(256);
  for (const value of gray.data) histogram[value]++;
  const half = gray.data.length / 2;
  let seen = 0;
  for (let value = 0; value < 256; value++) {
    seen += histogram[value];
    if (seen >= half) return value;
  }
  return 128;
}

/**
 * Find the document's corners, or report that there is no document-shaped
 * quadrilateral in the frame.
 *
 * Runs on a reduced copy: edge detection is dominated by noise at full
 * resolution and a 12-megapixel photo costs seconds for a result that is no
 * better. The corners come back in FULL-image coordinates, so callers never
 * have to know a working copy existed.
 */
export function detectDocument(
  cv: OpenCv,
  image: RawImage,
): { quad: Quad; found: boolean } {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const scale = fitScale(image.width, image.height, DETECT_MAX_EDGE);

    const working = scope.add(new cv.Mat());
    if (scale < 1) {
      cv.resize(
        source,
        working,
        new cv.Size(
          Math.max(1, Math.round(image.width * scale)),
          Math.max(1, Math.round(image.height * scale)),
        ),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      source.copyTo(working);
    }

    const gray = scope.add(new cv.Mat());
    cv.cvtColor(working, gray, cv.COLOR_RGBA2GRAY);
    const blurred = scope.add(new cv.Mat());
    cv.GaussianBlur(
      gray,
      blurred,
      new cv.Size(DETECT_BLUR_KERNEL, DETECT_BLUR_KERNEL),
      0,
      0,
      cv.BORDER_DEFAULT,
    );

    const median = medianIntensity(blurred as unknown as { data: Uint8Array });
    const edges = scope.add(new cv.Mat());
    cv.Canny(
      blurred,
      edges,
      Math.max(0, CANNY_LOW_RATIO * median),
      Math.min(255, CANNY_HIGH_RATIO * median),
    );
    // Close the hairline breaks a dashed border or a fold leaves behind, which
    // otherwise split the page outline into arcs that approximate to nothing.
    const dilateKernel = scope.add(
      cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(EDGE_DILATE_KERNEL, EDGE_DILATE_KERNEL),
      ),
    );
    cv.dilate(edges, edges, dilateKernel);

    const contours = scope.add(new cv.MatVector());
    const hierarchy = scope.add(new cv.Mat());
    cv.findContours(
      edges,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const frameArea = working.cols * working.rows;
    let best: { quad: Quad; area: number } | null = null;

    for (let i = 0; i < contours.size(); i++) {
      const contour = contours.get(i);
      const approx = new cv.Mat();
      try {
        const perimeter = cv.arcLength(contour, true);
        cv.approxPolyDP(contour, approx, POLY_EPSILON_RATIO * perimeter, true);
        if (approx.rows !== 4) continue;

        const points: Point[] = [];
        for (let p = 0; p < 4; p++) {
          points.push({
            x: approx.intAt(p, 0),
            y: approx.intAt(p, 1),
          });
        }
        const quad = orderCorners(points);
        if (!isConvexQuad(quad)) continue;

        const area = quadArea(quad);
        if (area < frameArea * MIN_DOCUMENT_AREA_RATIO) continue;
        if (!best || area > best.area) best = { quad, area };
      } finally {
        approx.delete();
        contour.delete();
      }
    }

    if (!best) {
      // No candidate is not a failure: the rest of the pipeline still runs, on
      // the whole frame, so the user gets a lighting-corrected photo and a quad
      // they can drag rather than an error.
      return { quad: fullFrameQuad(image.width, image.height), found: false };
    }
    return { quad: scaleQuad(best.quad, 1 / scale), found: true };
  });
}

/**
 * Flatten the document to a rectangle, then turn it upright if asked.
 *
 * The perspective transform corrects skew as well as tilt -- a rotated page maps
 * onto the output rectangle by the same matrix -- so there is no separate
 * deskew step. `rotation` is the user's own quarter turns, which no automatic
 * step can decide without reading the text.
 */
export function warpToQuad(
  cv: OpenCv,
  image: RawImage,
  quad: Quad,
  rotation: 0 | 1 | 2 | 3 = 0,
): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const size = outputSize(quad);

    const from = scope.add(
      cv.matFromArray(
        4,
        1,
        cv.CV_32FC2,
        quad.flatMap((p) => [p.x, p.y]),
      ),
    );
    const to = scope.add(
      cv.matFromArray(4, 1, cv.CV_32FC2, [
        0,
        0,
        size.width,
        0,
        size.width,
        size.height,
        0,
        size.height,
      ]),
    );
    const transform = scope.add(cv.getPerspectiveTransform(from, to));
    const warped = scope.add(new cv.Mat());
    cv.warpPerspective(
      source,
      warped,
      transform,
      new cv.Size(size.width, size.height),
      cv.INTER_LINEAR,
      cv.BORDER_CONSTANT,
      new cv.Scalar(255, 255, 255, 255),
    );

    if (rotation === 0) {
      return toRawImage(
        warped as unknown as { rows: number; cols: number; data: Uint8Array },
      );
    }
    const rotated = scope.add(new cv.Mat());
    const code =
      rotation === 1
        ? cv.ROTATE_90_CLOCKWISE
        : rotation === 2
          ? cv.ROTATE_180
          : cv.ROTATE_90_COUNTERCLOCKWISE;
    cv.rotate(warped, rotated, code);
    return toRawImage(
      rotated as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Even out the lighting, lift local contrast, then denoise and sharpen.
 *
 * The illumination estimate is a large morphological close, which keeps only
 * what varies slowly across the page -- the shadow of the hand holding the
 * phone, the falloff of a desk lamp. Dividing it out removes the gradient
 * without touching the glyphs, which is what makes the result read as a scan
 * rather than a brightened photo.
 */
export function enhance(cv: OpenCv, image: RawImage): RawImage {
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const rgb = scope.add(new cv.Mat());
    cv.cvtColor(source, rgb, cv.COLOR_RGBA2RGB);

    // 1. Illumination normalisation, per channel.
    const kernel = scope.add(
      cv.getStructuringElement(
        cv.MORPH_RECT,
        new cv.Size(ILLUMINATION_KERNEL, ILLUMINATION_KERNEL),
      ),
    );
    const background = scope.add(new cv.Mat());
    cv.morphologyEx(rgb, background, cv.MORPH_CLOSE, kernel);
    const normalised = scope.add(new cv.Mat());
    // 255 * channel / background: where the background is dark the pixel is
    // lifted by the same factor, so a shadowed corner ends up as bright as the
    // rest of the page instead of merely less dark.
    cv.divide(rgb, background, normalised, 255, cv.CV_8U);

    // 2. Local contrast on lightness only, so colours are not pushed around.
    const lab = scope.add(new cv.Mat());
    cv.cvtColor(normalised, lab, cv.COLOR_RGB2Lab);
    const channels = scope.add(new cv.MatVector());
    cv.split(lab, channels);
    const lightness = scope.add(channels.get(0));
    const clahe = scope.add(
      new cv.CLAHE(CLAHE_CLIP_LIMIT, new cv.Size(CLAHE_TILE, CLAHE_TILE)),
    );
    clahe.apply(lightness, lightness);
    channels.set(0, lightness);
    const merged = scope.add(new cv.Mat());
    cv.merge(channels, merged);
    const contrasted = scope.add(new cv.Mat());
    cv.cvtColor(merged, contrasted, cv.COLOR_Lab2RGB);

    // 3. Denoise, keeping edges.
    const denoised = scope.add(new cv.Mat());
    cv.bilateralFilter(
      contrasted,
      denoised,
      DENOISE_DIAMETER,
      DENOISE_SIGMA_COLOR,
      DENOISE_SIGMA_SPACE,
      cv.BORDER_DEFAULT,
    );

    // 4. Unsharp mask: the image plus its own high frequencies.
    const blurred = scope.add(new cv.Mat());
    cv.GaussianBlur(
      denoised,
      blurred,
      new cv.Size(0, 0),
      SHARPEN_SIGMA,
      SHARPEN_SIGMA,
      cv.BORDER_DEFAULT,
    );
    const sharpened = scope.add(new cv.Mat());
    cv.addWeighted(
      denoised,
      1 + SHARPEN_AMOUNT,
      blurred,
      -SHARPEN_AMOUNT,
      0,
      sharpened,
    );

    const rgba = scope.add(new cv.Mat());
    cv.cvtColor(sharpened, rgba, cv.COLOR_RGB2RGBA);
    return toRawImage(
      rgba as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}

/**
 * Reduce an image so its longest edge fits the upload ceiling.
 *
 * A phone photo warped at full resolution can exceed the 10 MB attachment
 * limit as a JPEG, and a document does not become more readable above a couple
 * of thousand pixels on its long edge.
 */
export function limitSize(cv: OpenCv, image: RawImage): RawImage {
  const scale = fitScale(image.width, image.height, OUTPUT_MAX_EDGE);
  if (scale === 1) return image;
  return withScope((scope) => {
    const source = scope.add(toMat(cv, image));
    const resized = scope.add(new cv.Mat());
    cv.resize(
      source,
      resized,
      new cv.Size(
        Math.max(1, Math.round(image.width * scale)),
        Math.max(1, Math.round(image.height * scale)),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    return toRawImage(
      resized as unknown as { rows: number; cols: number; data: Uint8Array },
    );
  });
}
