import { act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook } from '@/test/render';
import { useDocumentScanner } from './useDocumentScanner';
import type {
  Quad,
  RawImage,
  ScanResult,
  ScannerRequest,
  ScannerResponse,
} from '@/lib/document-scanner/document-scan.types';

/**
 * The hook's one job beyond wiring: making sure what is on screen belongs to
 * the photo on screen.
 *
 * A scan takes seconds and a user can retake in the middle of one, so the
 * answer to the abandoned photo arrives while the new one is still running.
 * Showing it is not a cosmetic slip -- the user then approves an enhanced
 * image of a document they discarded, and that is what gets stored.
 */

const decoded: RawImage = {
  width: 4,
  height: 4,
  data: new Uint8ClampedArray(64),
};

vi.mock('@/lib/document-scanner/decode-image', () => ({
  decodeImageFile: vi.fn(async () => decoded),
}));

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 4, y: 0 },
  { x: 4, y: 4 },
  { x: 0, y: 4 },
];

function resultWith(warning: 'blurry' | 'lowResolution'): ScanResult {
  return {
    documentFound: true,
    quad,
    enhanced: { width: 1, height: 1, data: new Uint8ClampedArray(4) },
    warnings: [warning],
  };
}

/** A worker double whose replies the test releases by hand. */
class ControllableWorker {
  readonly sent: ScannerRequest[] = [];
  onmessage: ((event: MessageEvent<ScannerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;

  postMessage(request: ScannerRequest): void {
    this.sent.push(request);
  }

  terminate(): void {
    /* nothing to release in the double */
  }

  reply(index: number, result: ScanResult): void {
    this.onmessage?.({
      data: { kind: 'result', requestId: this.sent[index].requestId, result },
    } as MessageEvent<ScannerResponse>);
  }

  replyError(index: number, message: string): void {
    this.onmessage?.({
      data: { kind: 'error', requestId: this.sent[index].requestId, message },
    } as MessageEvent<ScannerResponse>);
  }
}

describe('useDocumentScanner', () => {
  let worker: ControllableWorker;

  beforeEach(() => {
    worker = new ControllableWorker();
  });

  const render = () =>
    renderHook(() => useDocumentScanner(() => worker as unknown as Worker));

  const file = (name: string) =>
    new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });

  it('starts idle', () => {
    const { result } = render();
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('reports a completed scan with the photo it came from', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.result?.warnings).toEqual(['blurry']);
    expect(result.current.source).toEqual(decoded);
  });

  // The whole reason requests carry an id: the user retook the photo, and the
  // first scan's answer must not replace the second's.
  it('ignores the answer to a photo that has been replaced', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('first.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      void result.current.scan(file('second.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(2));

    // The SECOND photo answers first, then the abandoned first one.
    await act(async () => {
      worker.reply(1, resultWith('lowResolution'));
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    expect(result.current.result?.warnings).toEqual(['lowResolution']);
  });

  it('drops a scan that answers after a reset', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    act(() => {
      result.current.reset();
    });
    await act(async () => {
      worker.reply(0, resultWith('blurry'));
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('reports a failure without leaving the dialog waiting', async () => {
    const { result } = render();

    await act(async () => {
      void result.current.scan(file('receipt.jpg'));
    });
    await waitFor(() => expect(worker.sent).toHaveLength(1));

    await act(async () => {
      worker.replyError(0, 'the engine failed');
    });

    await waitFor(() => expect(result.current.status).toBe('failed'));
    expect(result.current.error).toBe('the engine failed');
  });

  describe('rewarp', () => {
    it('re-warps the photo already on screen with the user’s corners', async () => {
      const { result } = render();

      await act(async () => {
        void result.current.scan(file('receipt.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(1));
      await act(async () => {
        worker.reply(0, resultWith('blurry'));
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      const moved: Quad = [
        { x: 1, y: 1 },
        { x: 3, y: 1 },
        { x: 3, y: 3 },
        { x: 1, y: 3 },
      ];
      await act(async () => {
        void result.current.rewarp(moved, 1);
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      expect(worker.sent[1]).toMatchObject({
        kind: 'rewarp',
        quad: moved,
        rotation: 1,
        // The same decoded photo, not a re-read of the file.
        image: decoded,
      });
    });

    it('does nothing when there is no photo to re-warp', async () => {
      const { result } = render();
      await act(async () => {
        await result.current.rewarp(quad, 0);
      });
      expect(worker.sent).toHaveLength(0);
    });

    // A re-warp refines the photo on screen, so it must not outrank a scan of a
    // different photo that started after it.
    it('is discarded when a new photo has been chosen meanwhile', async () => {
      const { result } = render();

      await act(async () => {
        void result.current.scan(file('first.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(1));
      await act(async () => {
        worker.reply(0, resultWith('blurry'));
      });
      await waitFor(() => expect(result.current.status).toBe('ready'));

      await act(async () => {
        void result.current.rewarp(quad, 0);
      });
      await waitFor(() => expect(worker.sent).toHaveLength(2));

      // A new photo is picked before the re-warp comes back.
      await act(async () => {
        void result.current.scan(file('second.jpg'));
      });
      await waitFor(() => expect(worker.sent).toHaveLength(3));

      await act(async () => {
        worker.reply(1, resultWith('lowResolution'));
      });

      // Still loading the new photo; the stale re-warp did not land.
      expect(result.current.status).toBe('loading');
    });
  });
});
