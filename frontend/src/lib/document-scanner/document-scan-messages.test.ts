import { beforeAll, describe, expect, it } from 'vitest';

import { handleScanMessage } from './document-scan-messages';
import { loadEngine } from './opencv-engine';
import { DEFAULT_QUAD, syntheticDocument } from './synthetic-document';
import type { Quad } from './document-scan.types';

/**
 * What the worker does with a message, tested without a worker.
 *
 * The entry point is three lines of `postMessage` plumbing that no unit
 * environment can run, so the decisions live here: which pipeline steps a
 * request kind runs, and what a failure becomes.
 */
beforeAll(async () => {
  await loadEngine();
}, 60_000);

describe('handleScanMessage', () => {
  it('answers a scan with the detection, the enhanced image and the warnings', async () => {
    const response = await handleScanMessage({
      kind: 'scan',
      requestId: 7,
      image: syntheticDocument(),
    });

    expect(response.kind).toBe('result');
    if (response.kind !== 'result') return;
    expect(response.requestId).toBe(7);
    expect(response.result.documentFound).toBe(true);
    expect(response.result.enhanced.width).toBeGreaterThan(0);
    expect(Array.isArray(response.result.warnings)).toBe(true);
  });

  // The user has just overruled the detection by dragging a corner; detecting
  // again would throw their correction away.
  it('keeps the corners it was given on a re-warp', async () => {
    const moved: Quad = [
      { x: 160, y: 110 },
      { x: 600, y: 170 },
      { x: 560, y: 620 },
      { x: 120, y: 540 },
    ];

    const response = await handleScanMessage({
      kind: 'rewarp',
      requestId: 9,
      image: syntheticDocument(),
      quad: moved,
      rotation: 0,
    });

    expect(response.kind).toBe('result');
    if (response.kind !== 'result') return;
    expect(response.result.quad).toEqual(moved);
    // The corners are the user's own now, so there is no detection to report
    // as having failed.
    expect(response.result.documentFound).toBe(true);
  });

  it('applies the rotation a re-warp asks for', async () => {
    const image = syntheticDocument();
    const upright = await handleScanMessage({
      kind: 'rewarp',
      requestId: 1,
      image,
      quad: DEFAULT_QUAD,
      rotation: 0,
    });
    const turned = await handleScanMessage({
      kind: 'rewarp',
      requestId: 2,
      image,
      quad: DEFAULT_QUAD,
      rotation: 1,
    });

    if (upright.kind !== 'result' || turned.kind !== 'result') {
      throw new Error('expected both to succeed');
    }
    expect(turned.result.enhanced.width).toBe(upright.result.enhanced.height);
  });

  // A rejected promise inside the worker never reaches the page, so a failure
  // has to come back as a message -- carrying the id, or the client cannot
  // match it to the request that is waiting.
  it('reports a failure as a message carrying the request id', async () => {
    const response = await handleScanMessage({
      kind: 'scan',
      requestId: 42,
      // Zero-sized: the pipeline cannot build a Mat from it.
      image: { width: 0, height: 0, data: new Uint8ClampedArray(0) },
    });

    expect(response.kind).toBe('error');
    expect(response.requestId).toBe(42);
  });
});
