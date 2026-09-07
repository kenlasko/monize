import { describe, expect, it } from 'vitest';

import {
  DETECT_MAX_EDGE,
  clampToFrame,
  distance,
  fitScale,
  fullFrameQuad,
  isConvexQuad,
  orderCorners,
  outputSize,
  quadArea,
  rotatedSize,
  scaleQuad,
  touchesFrameEdge,
} from './document-scan-geometry';
import type { Point, Quad } from './document-scan.types';

/**
 * The scanner's arithmetic, which is where a scan goes wrong in ways a picture
 * cannot show you: a mirrored warp looks like a bad photo, and an output sized
 * from the wrong edge looks like a bad camera.
 */
describe('orderCorners', () => {
  const tl: Point = { x: 10, y: 10 };
  const tr: Point = { x: 90, y: 20 };
  const br: Point = { x: 80, y: 95 };
  const bl: Point = { x: 5, y: 85 };

  it('puts four corners into top-left, top-right, bottom-right, bottom-left order', () => {
    expect(orderCorners([tl, tr, br, bl])).toEqual([tl, tr, br, bl]);
  });

  // findContours walks the boundary from wherever it first met it, so the same
  // document arrives rotated or reversed run to run. Every arrival has to give
  // the same answer, or the warp is a coin toss between upright and mirrored.
  it.each([
    { label: 'reversed', points: [bl, br, tr, tl] },
    { label: 'rotated by one', points: [tr, br, bl, tl] },
    { label: 'rotated by two', points: [br, bl, tl, tr] },
    { label: 'shuffled', points: [br, tl, bl, tr] },
  ])('normalises a $label winding to the same order', ({ points }) => {
    expect(orderCorners(points)).toEqual([tl, tr, br, bl]);
  });

  it('orders a strongly skewed quadrilateral by position, not by angle', () => {
    // A photo taken from the side: the right edge is much shorter than the
    // left. Sorting by angle around the centroid swaps two of these.
    const skewed: Point[] = [
      { x: 20, y: 10 },
      { x: 300, y: 90 },
      { x: 300, y: 140 },
      { x: 20, y: 260 },
    ];
    expect(orderCorners(skewed)).toEqual([
      { x: 20, y: 10 },
      { x: 300, y: 90 },
      { x: 300, y: 140 },
      { x: 20, y: 260 },
    ]);
  });

  it('refuses anything that is not four points', () => {
    expect(() => orderCorners([tl, tr, br])).toThrow(/4 corners/);
    expect(() => orderCorners([tl, tr, br, bl, tl])).toThrow(/4 corners/);
  });
});

describe('outputSize', () => {
  it('takes the longer of each pair of opposite edges', () => {
    // A page photographed from above its far edge: the near (bottom) edge is
    // 200 across and the far one 100. The near edge carries the true scale, so
    // sizing from the far one would throw away half the resolution.
    const quad: Quad = [
      { x: 50, y: 0 },
      { x: 150, y: 0 },
      { x: 200, y: 300 },
      { x: 0, y: 300 },
    ];
    // Height is the slanted side, hypot(50, 300), not the 300 of the drop --
    // both sides are equal here, so the max is that length rounded.
    expect(outputSize(quad)).toEqual({
      width: 200,
      height: Math.round(Math.hypot(50, 300)),
    });
  });

  it('never produces a zero dimension', () => {
    const degenerate: Quad = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(outputSize(degenerate)).toEqual({ width: 1, height: 1 });
  });
});

describe('fitScale', () => {
  it('reduces so the longest edge meets the ceiling', () => {
    expect(fitScale(4000, 3000, 1000)).toBeCloseTo(0.25);
    expect(fitScale(3000, 4000, 1000)).toBeCloseTo(0.25);
  });

  // Enlarging invents detail, and an upscaled blurry photo reads as a sharp
  // one to both the user and the blur check.
  it('never enlarges an image that already fits', () => {
    expect(fitScale(400, 300, DETECT_MAX_EDGE)).toBe(1);
    expect(fitScale(1000, 1000, DETECT_MAX_EDGE)).toBe(1);
  });
});

describe('scaleQuad', () => {
  it('maps corners between the working copy and the full image', () => {
    const quad: Quad = [
      { x: 10, y: 20 },
      { x: 110, y: 20 },
      { x: 110, y: 120 },
      { x: 10, y: 120 },
    ];
    const halved = scaleQuad(quad, 0.5);
    expect(halved[2]).toEqual({ x: 55, y: 60 });
    // Round trip: detection scales down, then reports in full coordinates.
    expect(scaleQuad(halved, 2)).toEqual(quad);
  });
});

describe('isConvexQuad', () => {
  const square: Quad = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ];

  it('accepts a convex quadrilateral in either winding', () => {
    expect(isConvexQuad(square)).toBe(true);
    expect(
      isConvexQuad([square[0], square[3], square[2], square[1]] as Quad),
    ).toBe(true);
  });

  // A corner dragged across its neighbour. getPerspectiveTransform accepts it
  // and returns a folded image, so this is caught before the warp.
  it('rejects a bow tie', () => {
    expect(
      isConvexQuad([
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toBe(false);
  });

  it('rejects three collinear corners', () => {
    expect(
      isConvexQuad([
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ]),
    ).toBe(false);
  });
});

describe('quadArea', () => {
  it('measures a rectangle', () => {
    expect(quadArea(fullFrameQuad(200, 100))).toBe(20000);
  });

  it('is independent of winding direction', () => {
    const quad = fullFrameQuad(200, 100);
    const reversed = [quad[3], quad[2], quad[1], quad[0]] as Quad;
    expect(quadArea(reversed)).toBe(quadArea(quad));
  });
});

describe('touchesFrameEdge', () => {
  it('flags a document running off the side of the photo', () => {
    const quad: Quad = [
      { x: 0, y: 30 },
      { x: 180, y: 30 },
      { x: 180, y: 170 },
      { x: 0, y: 170 },
    ];
    expect(touchesFrameEdge(quad, 200, 200, 2)).toBe(true);
  });

  it('leaves a document with clearance alone', () => {
    const quad: Quad = [
      { x: 20, y: 20 },
      { x: 180, y: 20 },
      { x: 180, y: 180 },
      { x: 20, y: 180 },
    ];
    expect(touchesFrameEdge(quad, 200, 200, 2)).toBe(false);
  });
});

describe('rotatedSize', () => {
  it('swaps the dimensions for quarter turns only', () => {
    const size = { width: 300, height: 200 };
    expect(rotatedSize(size, 0)).toEqual(size);
    expect(rotatedSize(size, 1)).toEqual({ width: 200, height: 300 });
    expect(rotatedSize(size, 2)).toEqual(size);
    expect(rotatedSize(size, 3)).toEqual({ width: 200, height: 300 });
  });
});

describe('clampToFrame', () => {
  it('keeps a dragged corner inside the image', () => {
    expect(clampToFrame({ x: -30, y: 500 }, 200, 200)).toEqual({
      x: 0,
      y: 200,
    });
    expect(clampToFrame({ x: 100, y: 100 }, 200, 200)).toEqual({
      x: 100,
      y: 100,
    });
  });
});

describe('distance', () => {
  it('measures a 3-4-5 triangle', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });
});
