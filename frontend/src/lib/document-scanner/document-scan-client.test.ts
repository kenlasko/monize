import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SCAN_TIMEOUT_MS, createScannerClient } from './document-scan-client';
import type {
  Quad,
  RawImage,
  ScanResult,
  ScannerRequest,
  ScannerResponse,
} from './document-scan.types';

/**
 * The main thread's half of the scanner: request identity and failure.
 *
 * The worker is a double here on purpose -- what is under test is which reply
 * the client accepts and which it drops, and a real worker would make that a
 * question about timing rather than about the rule.
 */
class FakeWorker {
  readonly sent: ScannerRequest[] = [];
  onmessage: ((event: MessageEvent<ScannerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;

  postMessage(request: ScannerRequest): void {
    this.sent.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer one request, as the worker would. */
  reply(response: ScannerResponse): void {
    this.onmessage?.({ data: response } as MessageEvent<ScannerResponse>);
  }

  fail(message: string): void {
    this.onerror?.({ message } as ErrorEvent);
  }
}

const image: RawImage = {
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(16),
};

const quad: Quad = [
  { x: 0, y: 0 },
  { x: 2, y: 0 },
  { x: 2, y: 2 },
  { x: 0, y: 2 },
];

function resultFor(label: string): ScanResult {
  return {
    documentFound: true,
    quad,
    enhanced: {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 0]),
    },
    // The label rides on a warning so two results are distinguishable.
    warnings: [label as 'blurry'],
  };
}

describe('createScannerClient', () => {
  let worker: FakeWorker;

  beforeEach(() => {
    worker = new FakeWorker();
  });

  /**
   * Every client built in this file, closed after the test.
   *
   * A request nobody answers keeps a timeout timer alive, and a later test that
   * installs fake timers then fires it -- reporting a rejection from a test that
   * had already finished. Closing each client settles its work and clears its
   * timers, so no test can leak one into the next.
   */
  let clients: ReturnType<typeof createScannerClient>[] = [];

  afterEach(() => {
    for (const scanner of clients) scanner.dispose();
    clients = [];
    vi.useRealTimers();
  });

  const client = () => {
    const scanner = createScannerClient(() => worker as unknown as Worker);
    clients.push(scanner);
    return scanner;
  };

  it('sends a scan request and resolves with the result the worker returns', async () => {
    const scanner = client();
    const pending = scanner.scan(image);

    expect(worker.sent).toHaveLength(1);
    expect(worker.sent[0].kind).toBe('scan');

    worker.reply({
      kind: 'result',
      requestId: worker.sent[0].requestId,
      result: resultFor('blurry'),
    });

    await expect(pending).resolves.toMatchObject({ documentFound: true });
  });

  it('sends the corners and rotation on a re-warp', async () => {
    const scanner = client();
    // Never answered: this case is about what was SENT. The rejection is
    // absorbed so a timeout after the test cannot surface as an unhandled one.
    scanner.rewarp(image, quad, 2).catch(() => undefined);

    expect(worker.sent[0]).toMatchObject({
      kind: 'rewarp',
      quad,
      rotation: 2,
    });
  });

  it('gives every request its own id', () => {
    const scanner = client();
    scanner.scan(image).catch(() => undefined);
    scanner.scan(image).catch(() => undefined);

    expect(worker.sent[0].requestId).not.toBe(worker.sent[1].requestId);
  });

  // The case the ids exist for: a user retakes a photo while the first scan is
  // still running, and the first one's answer arrives second.
  it('answers each request with its own result, whatever the order', async () => {
    const scanner = client();
    const first = scanner.scan(image);
    const second = scanner.scan(image);
    const [firstId, secondId] = worker.sent.map((r) => r.requestId);

    worker.reply({
      kind: 'result',
      requestId: secondId,
      result: resultFor('lowResolution'),
    });
    worker.reply({
      kind: 'result',
      requestId: firstId,
      result: resultFor('blurry'),
    });

    await expect(first).resolves.toMatchObject({ warnings: ['blurry'] });
    await expect(second).resolves.toMatchObject({
      warnings: ['lowResolution'],
    });
  });

  it('ignores a reply for a request it has already settled', async () => {
    const scanner = client();
    const pending = scanner.scan(image);
    const { requestId } = worker.sent[0];

    worker.reply({ kind: 'result', requestId, result: resultFor('blurry') });
    await expect(pending).resolves.toMatchObject({ warnings: ['blurry'] });

    // A duplicate would otherwise try to resolve a promise that is gone.
    expect(() =>
      worker.reply({
        kind: 'result',
        requestId,
        result: resultFor('lowResolution'),
      }),
    ).not.toThrow();
  });

  it('rejects when the worker reports an error for that request', async () => {
    const scanner = client();
    const pending = scanner.scan(image);
    worker.reply({
      kind: 'error',
      requestId: worker.sent[0].requestId,
      message: 'no engine',
    });
    await expect(pending).rejects.toThrow('no engine');
  });

  // A worker that dies answers nothing, so every outstanding promise has to be
  // settled here or the dialog waits forever on a reply that cannot come.
  it('rejects everything outstanding when the worker itself fails', async () => {
    const scanner = client();
    const first = scanner.scan(image);
    const second = scanner.scan(image);

    worker.fail('worker died');

    await expect(first).rejects.toThrow('worker died');
    await expect(second).rejects.toThrow('worker died');
  });

  it('rejects a request that never comes back', async () => {
    vi.useFakeTimers();
    const scanner = client();
    // The expectation is attached BEFORE the clock moves: advancing first
    // rejects the promise while nothing is listening, which Node reports as an
    // unhandled rejection even though the test goes on to assert it.
    const settled = expect(scanner.scan(image)).rejects.toThrow(/timed out/);

    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS + 1);

    await settled;
  });

  it('does not time out a request that was answered', async () => {
    vi.useFakeTimers();
    const scanner = client();
    const pending = scanner.scan(image);
    worker.reply({
      kind: 'result',
      requestId: worker.sent[0].requestId,
      result: resultFor('blurry'),
    });
    await expect(pending).resolves.toBeTruthy();

    // The timer must have been cleared with the request; if it had not, this
    // would try to reject a settled promise.
    await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS + 1);
  });

  describe('dispose', () => {
    it('terminates the worker and rejects what was outstanding', async () => {
      const scanner = client();
      const pending = scanner.scan(image);

      scanner.dispose();

      expect(worker.terminated).toBe(true);
      await expect(pending).rejects.toThrow(/closed/);
    });

    it('refuses further work once closed', async () => {
      const scanner = client();
      scanner.dispose();
      await expect(scanner.scan(image)).rejects.toThrow(/closed/);
    });

    it('is safe to call twice', () => {
      const scanner = client();
      scanner.dispose();
      expect(() => scanner.dispose()).not.toThrow();
    });
  });
});
