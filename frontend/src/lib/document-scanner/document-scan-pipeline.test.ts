import { beforeAll, describe, expect, it } from 'vitest';

import { loadEngine, type OpenCv } from './opencv-engine';
import {
  detectDocument,
  enhance,
  limitSize,
  warpToQuad,
} from './document-scan-pipeline';
import { assessCapture, blurVariance } from './document-scan-quality';
import { OUTPUT_MAX_EDGE, outputSize } from './document-scan-geometry';
import {
  DEFAULT_QUAD,
  blankFrame,
  syntheticDocument,
} from './synthetic-document';
import type { Quad, RawImage } from './document-scan.types';

/**
 * The pipeline against the REAL OpenCV build, on pictures whose answer is known
 * because we drew them.
 *
 * A double for `cv` here would prove only that the steps were called in order,
 * which is the one thing that was never in doubt: what can be wrong is the
 * corners it finds, the direction it flattens them in, and whether the
 * enhancement makes a shadowed page readable or merely different. That needs
 * real pixels.
 *
 * The engine is loaded once for the file -- it initialises in well under a
 * second, but not per test.
 */
let cv: OpenCv;

beforeAll(async () => {
  cv = await loadEngine();
}, 60_000);

/** How far a detected corner may sit from the planted one, in pixels. */
const CORNER_TOLERANCE = 12;

function expectNearQuad(found: Quad, expected: Quad): void {
  for (let i = 0; i < 4; i++) {
    expect(Math.abs(found[i].x - expected[i].x)).toBeLessThanOrEqual(
      CORNER_TOLERANCE,
    );
    expect(Math.abs(found[i].y - expected[i].y)).toBeLessThanOrEqual(
      CORNER_TOLERANCE,
    );
  }
}

/** Mean intensity of a rectangular region, for comparing lighting. */
function meanIntensity(
  image: RawImage,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  let total = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      total += image.data[(y * image.width + x) * 4];
      count++;
    }
  }
  return total / count;
}

describe('detectDocument', () => {
  it('finds the planted corners of a skewed page', () => {
    const image = syntheticDocument();
    const { quad, found } = detectDocument(cv, image);

    expect(found).toBe(true);
    expectNearQuad(quad, DEFAULT_QUAD);
  });

  it('reports the corners in full-image coordinates for a large photo', () => {
    // Twice the detection ceiling, so the working copy is genuinely smaller and
    // a scale-back that was forgotten would halve every coordinate.
    const scale = 3;
    const quad = DEFAULT_QUAD.map((p) => ({
      x: p.x * scale,
      y: p.y * scale,
    })) as unknown as Quad;
    const image = syntheticDocument({
      width: 720 * scale,
      height: 720 * scale,
      quad,
      text: false,
    });

    const detected = detectDocument(cv, image);

    expect(detected.found).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(detected.quad[i].x - quad[i].x)).toBeLessThanOrEqual(
        CORNER_TOLERANCE * scale,
      );
    }
  });

  // Not finding a document is a normal outcome, not an error: the rest of the
  // pipeline still runs on the whole frame so the user gets something to drag.
  it('falls back to the whole frame when there is no document', () => {
    const image = blankFrame(400, 400);
    const { quad, found } = detectDocument(cv, image);

    expect(found).toBe(false);
    expect(quad).toEqual([
      { x: 0, y: 0 },
      { x: 400, y: 0 },
      { x: 400, y: 400 },
      { x: 0, y: 400 },
    ]);
  });

  it('ignores a mark too small to be the document', () => {
    // A stamp covering ~4% of the frame: well under the area floor.
    const image = syntheticDocument({
      width: 500,
      height: 500,
      quad: [
        { x: 200, y: 200 },
        { x: 300, y: 200 },
        { x: 300, y: 300 },
        { x: 200, y: 300 },
      ],
      text: false,
    });

    expect(detectDocument(cv, image).found).toBe(false);
  });
});

describe('warpToQuad', () => {
  it('flattens the skewed page to the size its longest edges imply', () => {
    const image = syntheticDocument();
    const warped = warpToQuad(cv, image, DEFAULT_QUAD);
    const expected = outputSize(DEFAULT_QUAD);

    expect(warped.width).toBe(expected.width);
    expect(warped.height).toBe(expected.height);
  });

  // The corner order decides which way up the result is. A mirrored or rotated
  // warp is a correct detection rendered useless, and it looks like a bad photo.
  it('puts the page the right way round', () => {
    // A page with a dark band along its TOP quarter only.
    const width = 400;
    const height = 400;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = y < height / 4 ? 20 : 230;
        const offset = (y * width + x) * 4;
        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }
    const image: RawImage = { width, height, data };
    const quad: Quad = [
      { x: 0, y: 0 },
      { x: width, y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];

    const warped = warpToQuad(cv, image, quad);

    // Dark at the top, light at the bottom: unchanged, not flipped.
    expect(meanIntensity(warped, 10, 5, warped.width - 10, 30)).toBeLessThan(
      80,
    );
    expect(
      meanIntensity(
        warped,
        10,
        warped.height - 30,
        warped.width - 10,
        warped.height - 5,
      ),
    ).toBeGreaterThan(180);
  });

  it('rotates by quarter turns when asked', () => {
    const image = syntheticDocument();
    const upright = warpToQuad(cv, image, DEFAULT_QUAD, 0);
    const turned = warpToQuad(cv, image, DEFAULT_QUAD, 1);

    expect(turned.width).toBe(upright.height);
    expect(turned.height).toBe(upright.width);
  });
});

describe('enhance', () => {
  it('evens out a shadow across the page', () => {
    // A page lit from the right: the left side is markedly darker.
    const image = syntheticDocument({
      quad: [
        { x: 20, y: 20 },
        { x: 700, y: 20 },
        { x: 700, y: 700 },
        { x: 20, y: 700 },
      ],
      text: false,
      shadow: 0.55,
    });

    const before = {
      left: meanIntensity(image, 40, 100, 200, 600),
      right: meanIntensity(image, 520, 100, 680, 600),
    };
    const after = enhance(cv, image);
    const afterGap = Math.abs(
      meanIntensity(after, 40, 100, 200, 600) -
        meanIntensity(after, 520, 100, 680, 600),
    );

    // The gradient was real to begin with, and is materially reduced.
    expect(Math.abs(before.left - before.right)).toBeGreaterThan(40);
    expect(afterGap).toBeLessThan(Math.abs(before.left - before.right) / 2);
  });

  it('keeps the image the same size', () => {
    const image = syntheticDocument({ width: 300, height: 260, text: false });
    const result = enhance(cv, image);
    expect(result.width).toBe(300);
    expect(result.height).toBe(260);
  });

  // The preview the user approves is the file that gets stored, so the same
  // input has to produce the same bytes every time (I3).
  it('is deterministic', () => {
    const image = syntheticDocument({ width: 240, height: 240 });
    const first = enhance(cv, image);
    const second = enhance(cv, image);
    expect(Array.from(second.data)).toEqual(Array.from(first.data));
  });
});

describe('limitSize', () => {
  it('reduces an oversized image to the upload ceiling', () => {
    const image = blankFrame(OUTPUT_MAX_EDGE + 900, 400);
    const limited = limitSize(cv, image);
    expect(Math.max(limited.width, limited.height)).toBe(OUTPUT_MAX_EDGE);
  });

  it('leaves an image that already fits untouched', () => {
    const image = blankFrame(300, 200);
    expect(limitSize(cv, image)).toBe(image);
  });
});

describe('blurVariance', () => {
  it('separates a sharp capture from a blurred one', () => {
    const sharp = syntheticDocument();
    const blurred = syntheticDocument({ blurRadius: 6 });

    expect(blurVariance(cv, blurred)).toBeLessThan(blurVariance(cv, sharp));
  });
});

describe('assessCapture', () => {
  const output = { width: 900, height: 1200 };

  it('reports nothing for a sharp, fully framed page', () => {
    const image = syntheticDocument();
    const { quad } = detectDocument(cv, image);
    expect(assessCapture(cv, image, quad, true, output)).toEqual([]);
  });

  it('flags a blurred capture', () => {
    const image = syntheticDocument({ blurRadius: 8 });
    expect(assessCapture(cv, image, DEFAULT_QUAD, true, output)).toContain(
      'blurry',
    );
  });

  it('flags a document running off the edge of the frame', () => {
    const image = syntheticDocument({ text: false });
    const offEdge: Quad = [
      { x: 0, y: 0 },
      { x: 700, y: 40 },
      { x: 690, y: 700 },
      { x: 10, y: 690 },
    ];
    expect(assessCapture(cv, image, offEdge, true, output)).toContain(
      'edgesOutsideFrame',
    );
  });

  it('flags a capture where no document was found at all', () => {
    const image = syntheticDocument();
    expect(assessCapture(cv, image, DEFAULT_QUAD, false, output)).toContain(
      'edgesOutsideFrame',
    );
  });

  it('flags an output too small to read', () => {
    const image = syntheticDocument();
    expect(
      assessCapture(cv, image, DEFAULT_QUAD, true, { width: 400, height: 300 }),
    ).toContain('lowResolution');
  });
});
