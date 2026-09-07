import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@/test/render';

import { DocumentScanDialog } from './DocumentScanDialog';
import type {
  Quad,
  ScanResult,
  ScannerRequest,
  ScannerResponse,
} from '@/lib/document-scanner/document-scan.types';
import { MAX_ATTACHMENT_BYTES } from '@/types/attachment';

/**
 * The review step, where the user decides what to keep.
 *
 * The engine is replaced by a worker double: what is under test is the
 * dialog's promises to the user -- that a warning never blocks, that the
 * original is kept unless it cannot be, and that closing forgets the document.
 */

// Canvas work needs a real 2d context, which jsdom does not provide.
const encoded = new File(['scan-bytes'], 'receipt-scan.jpg', {
  type: 'image/jpeg',
});
vi.mock('@/lib/document-scanner/decode-image', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/document-scanner/decode-image')
  >()),
  decodeImageFile: vi.fn(async () => ({
    width: 40,
    height: 40,
    data: new Uint8ClampedArray(40 * 40 * 4),
  })),
  toCanvas: vi.fn(() => document.createElement('canvas')),
  encodeScan: vi.fn(async () => encoded),
}));

const quad: Quad = [
  { x: 4, y: 4 },
  { x: 36, y: 4 },
  { x: 36, y: 36 },
  { x: 4, y: 36 },
];

function scanResult(overrides: Partial<ScanResult> = {}): ScanResult {
  return {
    documentFound: true,
    quad,
    enhanced: { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) },
    warnings: [],
    ...overrides,
  };
}

/** A worker double that answers every request with the result it is given. */
class AutoWorker {
  readonly sent: ScannerRequest[] = [];
  onmessage: ((event: MessageEvent<ScannerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  result: ScanResult = scanResult();
  failWith: string | null = null;

  postMessage(request: ScannerRequest): void {
    this.sent.push(request);
    queueMicrotask(() => {
      this.onmessage?.({
        data: this.failWith
          ? {
              kind: 'error',
              requestId: request.requestId,
              message: this.failWith,
            }
          : {
              kind: 'result',
              requestId: request.requestId,
              result: this.result,
            },
      } as MessageEvent<ScannerResponse>);
    });
  }

  terminate(): void {
    /* nothing to release */
  }
}

describe('DocumentScanDialog', () => {
  let worker: AutoWorker;

  beforeEach(() => {
    worker = new AutoWorker();
    // jsdom has no 2d context and logs an unimplemented-method error for every
    // attempt. The painter already tolerates a missing context; stubbing it
    // keeps that expected absence out of the run's output.
    HTMLCanvasElement.prototype.getContext = vi.fn(
      () => null,
    ) as unknown as HTMLCanvasElement['getContext'];
  });

  const photo = (size = 1024) => {
    const file = new File(['photo'], 'receipt.jpg', { type: 'image/jpeg' });
    Object.defineProperty(file, 'size', { value: size });
    return file;
  };

  async function open(
    props: Partial<React.ComponentProps<typeof DocumentScanDialog>> = {},
  ) {
    const onAccept = vi.fn();
    const onCancel = vi.fn();
    const onRetake = vi.fn();
    await act(async () => {
      render(
        <DocumentScanDialog
          isOpen
          file={photo()}
          onAccept={onAccept}
          onCancel={onCancel}
          onRetake={onRetake}
          createWorker={() => worker as unknown as Worker}
          {...props}
        />,
      );
    });
    return { onAccept, onCancel, onRetake };
  }

  it('shows the preview and its actions once the scan finishes', async () => {
    await open();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
    );
    expect(screen.getByRole('button', { name: 'Keep original only' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retake' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Enhanced scan preview' })).toBeInTheDocument();
  });

  it('cannot accept an enhanced image before one exists', async () => {
    // The worker is never answered, so the dialog stays in its loading state.
    worker.postMessage = (request) => {
      worker.sent.push(request);
    };
    await open();

    expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeDisabled();
  });

  it('keeps both halves when the enhanced image is accepted', async () => {
    const original = photo();
    const { onAccept } = await open({ file: original });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use enhanced' }));
    });

    expect(onAccept).toHaveBeenCalledWith({ file: encoded, original });
  });

  it('keeps only the photo when the user declines the scan', async () => {
    const original = photo();
    const { onAccept } = await open({ file: original });

    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Keep original only' }),
      );
    });

    expect(onAccept).toHaveBeenCalledWith({ file: original });
  });

  // An original over the attachment limit cannot be stored, and silently
  // dropping it would leave the user believing they still have the photo.
  it('says so, and stores the scan alone, when the original is too large', async () => {
    const huge = photo(MAX_ATTACHMENT_BYTES + 1);
    const { onAccept } = await open({ file: huge });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
    );

    expect(screen.getByText(/only the enhanced scan will be attached/i)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Use enhanced' }));
    });

    expect(onAccept).toHaveBeenCalledWith({ file: encoded });
  });

  describe('quality warnings', () => {
    // Every warning is advice. A capture the user cannot repeat is worse lost
    // than imperfect, so none of them may take an action away.
    it.each([
      ['blurry', /blurred/i],
      ['edgesOutsideFrame', /outside the photo/i],
      ['lowResolution', /quite small/i],
    ])('shows %s without blocking acceptance', async (warning, copy) => {
      worker.result = scanResult({
        warnings: [warning as 'blurry'],
      });
      await open();

      await waitFor(() => expect(screen.getByText(copy)).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Retake' })).toBeEnabled();
    });

    it('says when no document was found and still offers the result', async () => {
      worker.result = scanResult({ documentFound: false });
      await open();

      await waitFor(() =>
        expect(screen.getByText(/No document edges were found/i)).toBeInTheDocument(),
      );
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled();
    });
  });

  it('reports a failure and still lets the photo be attached', async () => {
    worker.failWith = 'the engine failed';
    const original = photo();
    const { onAccept } = await open({ file: original });

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        /could not be scanned/i,
      ),
    );
    // The scan is unavailable; keeping the photo is not.
    expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeDisabled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Keep original only' }),
      );
    });
    expect(onAccept).toHaveBeenCalledWith({ file: original });
  });

  describe('the corner handles', () => {
    it('appear over the photo, not over the enhanced image', async () => {
      await open();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
      );

      // The enhanced view has no handles: its coordinates are not the photo's.
      expect(screen.queryByRole('slider')).not.toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });

      expect(screen.getAllByRole('slider')).toHaveLength(4);
    });

    it('re-warps the same photo when a corner is moved', async () => {
      await open();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
      );
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });

      await act(async () => {
        fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
          key: 'ArrowRight',
        });
      });

      await waitFor(() =>
        expect(worker.sent.some((r) => r.kind === 'rewarp')).toBe(true),
      );
    });
  });

  it('re-warps with the new rotation when the image is turned', async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    });

    await waitFor(() => {
      const rewarp = worker.sent.find((r) => r.kind === 'rewarp');
      expect(rewarp).toMatchObject({ rotation: 1 });
    });
  });

  it('scans nothing while it is closed', async () => {
    await act(async () => {
      render(
        <DocumentScanDialog
          isOpen={false}
          file={photo()}
          onAccept={vi.fn()}
          onCancel={vi.fn()}
          onRetake={vi.fn()}
          createWorker={() => worker as unknown as Worker}
        />,
      );
    });

    expect(worker.sent).toHaveLength(0);
  });
});
