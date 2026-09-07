import type {
  Quad,
  RawImage,
  ScanResult,
  ScannerRequest,
  ScannerResponse,
} from './document-scan.types';

/**
 * The main thread's handle on the scanner worker.
 *
 * Two things it owns that the worker cannot. First, request identity: a scan
 * takes seconds, a user can retake a photo or drag a corner while one is in
 * flight, and a late reply describing the PREVIOUS photo must not be shown as
 * the current one -- so every request carries an id and a reply for an id that
 * is no longer outstanding is dropped (`I6`, and `frontend/CLAUDE.md`'s rule
 * that asynchronous data belongs to the request that produced it).
 *
 * Second, failure: a worker that dies takes every pending promise with it
 * unless somebody rejects them, and a scan dialogue waiting forever on a
 * promise nobody will settle is the worst of the failure modes.
 */

/** How long a single scan may take before it is treated as hung. */
export const SCAN_TIMEOUT_MS = 60_000;

interface Pending {
  resolve: (result: ScanResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ScannerClient {
  scan(image: RawImage): Promise<ScanResult>;
  rewarp(
    image: RawImage,
    quad: Quad,
    rotation: 0 | 1 | 2 | 3,
  ): Promise<ScanResult>;
  dispose(): void;
}

/** Build the worker. Replaceable so tests can supply a double. */
export type WorkerFactory = () => Worker;

const defaultWorkerFactory: WorkerFactory = () =>
  new Worker(new URL('./document-scan.worker.ts', import.meta.url), {
    type: 'module',
  });

export function createScannerClient(
  createWorker: WorkerFactory = defaultWorkerFactory,
): ScannerClient {
  const worker = createWorker();
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let disposed = false;

  const settle = (id: number, apply: (entry: Pending) => void): void => {
    const entry = pending.get(id);
    // No entry means the request was already settled -- timed out, or answered
    // and then answered again. Dropping it is the point.
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(id);
    apply(entry);
  };

  worker.onmessage = (event: MessageEvent<ScannerResponse>) => {
    const response = event.data;
    settle(response.requestId, (entry) => {
      if (response.kind === 'result') entry.resolve(response.result);
      else entry.reject(new Error(response.message));
    });
  };

  worker.onerror = (event: ErrorEvent) => {
    // The worker itself failed, so nothing outstanding will ever be answered.
    const error = new Error(event.message || 'The document scanner failed');
    for (const id of [...pending.keys()]) {
      settle(id, (entry) => entry.reject(error));
    }
  };

  const send = (
    build: (requestId: number) => ScannerRequest,
  ): Promise<ScanResult> => {
    if (disposed) {
      return Promise.reject(new Error('The document scanner was closed'));
    }
    const requestId = nextId++;
    const request = build(requestId);
    return new Promise<ScanResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        settle(requestId, (entry) =>
          entry.reject(new Error('The document scanner timed out')),
        );
      }, SCAN_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      worker.postMessage(request);
    });
  };

  return {
    scan: (image) => send((requestId) => ({ kind: 'scan', requestId, image })),
    rewarp: (image, quad, rotation) =>
      send((requestId) => ({
        kind: 'rewarp',
        requestId,
        image,
        quad,
        rotation,
      })),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      for (const id of [...pending.keys()]) {
        settle(id, (entry) =>
          entry.reject(new Error('The document scanner was closed')),
        );
      }
      worker.terminate();
    },
  };
}
