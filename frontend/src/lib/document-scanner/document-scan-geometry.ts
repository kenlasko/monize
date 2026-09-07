import type { Point, Quad } from './document-scan.types';

/**
 * The document scanner's geometry, as plain arithmetic.
 *
 * Everything here is separable from OpenCV on purpose. Corner ordering, output
 * sizing, the working-copy scale and the convexity check are where a scan goes
 * subtly wrong -- a mirrored warp, an output stretched to the wrong aspect, a
 * quad the user dragged inside out -- and none of them needs an image to
 * decide. Kept here they are ordinary functions with ordinary tests, instead of
 * assertions about pixels that only a browser can produce.
 */

/** The longest edge of the working copy detection runs on. */
export const DETECT_MAX_EDGE = 1000;

/** The longest edge of the enhanced image that gets uploaded. */
export const OUTPUT_MAX_EDGE = 2500;

/**
 * The smallest share of the frame a detected quadrilateral may cover before it
 * is dismissed as a logo, a tile or a shadow rather than the document.
 */
export const MIN_DOCUMENT_AREA_RATIO = 0.2;

/**
 * Order four corners as top-left, top-right, bottom-right, bottom-left.
 *
 * `findContours` returns points in whatever order it walked the boundary, and
 * `getPerspectiveTransform` maps corner 0 to corner 0 -- so an unordered quad
 * produces a rotated or mirrored document from a perfectly good detection.
 *
 * Sum and difference rather than angle sorting: on a convex quadrilateral the
 * top-left minimises `x + y` and the top-right maximises `x - y`, which stays
 * true under the perspective skew a photo actually has, where sorting by angle
 * around the centroid can swap two corners of a strongly trapezoidal document.
 */
export function orderCorners(points: readonly Point[]): Quad {
  if (points.length !== 4) {
    throw new Error(`expected 4 corners, received ${points.length}`);
  }
  const bySum = [...points].sort((a, b) => a.x + a.y - (b.x + b.y));
  const byDiff = [...points].sort((a, b) => a.x - a.y - (b.x - b.y));
  const topLeft = bySum[0];
  const bottomRight = bySum[3];
  const bottomLeft = byDiff[0];
  const topRight = byDiff[3];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

/** Euclidean distance between two points. */
export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * The size the warped document should have.
 *
 * Each output dimension takes the LONGER of the two opposite edges: in a photo
 * taken at an angle the near edge is longer than the far one, and the near edge
 * is the one carrying the true scale. Taking the shorter (or an average) throws
 * away resolution the capture actually holds.
 */
export function outputSize(quad: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = quad;
  const width = Math.max(distance(tl, tr), distance(bl, br));
  const height = Math.max(distance(tl, bl), distance(tr, br));
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
  };
}

/**
 * The scale a dimension pair is reduced by so its longest edge fits `maxEdge`.
 *
 * Never above 1: a small photo is not enlarged, which would invent detail and
 * make an already-poor capture look deceptively sharp.
 */
export function fitScale(
  width: number,
  height: number,
  maxEdge: number,
): number {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return 1;
  return maxEdge / longest;
}

/** Scale a quad's corners by a factor, for moving between working sizes. */
export function scaleQuad(quad: Quad, factor: number): Quad {
  return quad.map((p) => ({
    x: p.x * factor,
    y: p.y * factor,
  })) as unknown as Quad;
}

/** The whole frame, as the quad used when no document was detected. */
export function fullFrameQuad(width: number, height: number): Quad {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: width, y: height },
    { x: 0, y: height },
  ];
}

/** Twice the signed area of a polygon (the shoelace sum). */
function signedArea2(points: readonly Point[]): number {
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    total += a.x * b.y - b.x * a.y;
  }
  return total;
}

/** The area a quad covers, in square pixels. */
export function quadArea(quad: Quad): number {
  return Math.abs(signedArea2(quad)) / 2;
}

/**
 * Whether a quad is still a simple convex quadrilateral.
 *
 * A corner dragged across its neighbour makes a bow-tie, which
 * `getPerspectiveTransform` accepts and turns into a folded, unreadable image.
 * Every cross product of consecutive edges has to share a sign; a zero (three
 * collinear corners) is degenerate and also rejected.
 */
export function isConvexQuad(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const c = quad[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross === 0) return false;
    const current = Math.sign(cross);
    if (sign === 0) sign = current;
    else if (current !== sign) return false;
  }
  return true;
}

/**
 * Whether any corner sits within `margin` of the frame edge.
 *
 * A document running off the edge of the photo has information the pipeline
 * cannot recover, so this is what `edgesOutsideFrame` is decided from.
 */
export function touchesFrameEdge(
  quad: Quad,
  width: number,
  height: number,
  margin: number,
): boolean {
  return quad.some(
    (p) =>
      p.x <= margin ||
      p.y <= margin ||
      p.x >= width - margin ||
      p.y >= height - margin,
  );
}

/** Rotate a size by a number of quarter turns. */
export function rotatedSize(
  size: { width: number; height: number },
  rotation: 0 | 1 | 2 | 3,
): { width: number; height: number } {
  return rotation % 2 === 0
    ? { width: size.width, height: size.height }
    : { width: size.height, height: size.width };
}

/**
 * Clamp a point into the frame.
 *
 * A corner handle dragged past the edge of the image would otherwise sample
 * outside the source, which OpenCV fills with black -- a border the user did not
 * ask for and cannot remove without starting again.
 */
export function clampToFrame(
  point: Point,
  width: number,
  height: number,
): Point {
  return {
    x: Math.min(Math.max(point.x, 0), width),
    y: Math.min(Math.max(point.y, 0), height),
  };
}
