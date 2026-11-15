import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@/test/render';

import { DocumentScanDialog } from './DocumentScanDialog';
import type {
  Quad,
  RawImage,
  ScanResult,
  ScannerRequest,
  ScannerResponse,
} from '@/lib/document-scanner/document-scan.types';
import { MAX_ATTACHMENT_BYTES } from '@/types/attachment';
import { useScanSettingsStore } from '@/store/scanSettingsStore';
import { NEUTRAL_ADJUSTMENTS } from '@/lib/document-scanner/adjust-image';
import { DEFAULT_SCAN_STYLE } from '@/lib/document-scanner/document-scan.types';
import { buttonClassName } from '@/components/ui/Button';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

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
    warped: { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) },
    enhanced: { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) },
    style: 'colour',
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
  /** What a restyle comes back with, when a case cares. */
  restyled: RawImage | null = null;
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
          : request.kind === 'restyle'
            ? {
                kind: 'image',
                requestId: request.requestId,
                image: this.restyled ?? this.result.enhanced,
                style: request.style,
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
    // The finish and slider offsets are remembered in a persisted store; reset
    // it so one test's chosen finish does not open the next test's dialog.
    window.localStorage.clear();
    useScanSettingsStore.setState({
      style: DEFAULT_SCAN_STYLE,
      adjustments: NEUTRAL_ADJUSTMENTS,
    });
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
    // ...and keeping it ALONE is not offered, because the server would refuse
    // it with a 413 the user would have to interpret themselves.
    expect(
      screen.getByRole('button', { name: 'Keep original only' }),
    ).toBeDisabled();

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
      ['edgesOutsideFrame', /reaches the edge of the photo/i],
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

  it('switches the preview with a segmented control, leaving Use enhanced the one primary', async () => {
    await open();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
    );
    const group = screen.getByRole('group', { name: 'Version' });
    expect(group.className).toBe(SEGMENTED_GROUP_CLASS);
    expect(screen.getByRole('button', { name: 'Enhanced' }).className).toBe(segmentClass(true));
    const primaries = screen
      .getAllByRole('button')
      .filter((button) => button.className.includes(buttonClassName('primary')));
    expect(primaries.map((b) => b.textContent)).toEqual(['Use enhanced']);
  });

  describe('the corner handles', () => {
    it('appear over the photo, not over the enhanced image', async () => {
      await open();
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Use enhanced' })).toBeEnabled(),
      );

      // The enhanced view has no handles: its coordinates are not the photo's.
      // Asked by name rather than by role -- the brightness and contrast
      // controls on this view are sliders too.
      expect(screen.queryByLabelText('Top-left corner')).not.toBeInTheDocument();

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

    // A re-warp deliberately leaves the previous preview up rather than
    // blanking the dialog, so with nothing said the picture just looks like it
    // ignored the drag -- and accepting it would store the image the corners
    // were moved away from.
    describe('while the re-warp is still running', () => {
      /** Answers the scan, then holds the re-warp open. */
      function holdRewarp() {
        const answer = worker.postMessage.bind(worker);
        worker.postMessage = (request: ScannerRequest) => {
          if (request.kind === 'rewarp') {
            worker.sent.push(request);
            return;
          }
          answer(request);
        };
      }

      async function dragACorner() {
        await open();
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'Use enhanced' }),
          ).toBeEnabled(),
        );
        holdRewarp();
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Original' }));
        });
        await act(async () => {
          fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
            key: 'ArrowRight',
          });
        });
      }

      it('says the preview is being updated', async () => {
        await dragACorner();

        await waitFor(() =>
          expect(screen.getByText('Updating the preview…')).toBeInTheDocument(),
        );
      });

      it('will not hand back the preview it is about to replace', async () => {
        await dragACorner();

        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'Use enhanced' }),
          ).toBeDisabled(),
        );
      });

      it('offers it again once the re-warp lands', async () => {
        await open();
        await waitFor(() =>
          expect(
            screen.getByRole('button', { name: 'Use enhanced' }),
          ).toBeEnabled(),
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
          expect(
            screen.getByRole('button', { name: 'Use enhanced' }),
          ).toBeEnabled(),
        );
        expect(screen.queryByText('Updating the preview…')).not.toBeInTheDocument();
      });
    });
  });

  describe('magnifying', () => {
    async function ready() {
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );
    }

    it('magnifies the preview on a wheel', async () => {
      await ready();
      const content = screen.getByRole('img', {
        name: 'Enhanced scan preview',
      }).parentElement as HTMLElement;
      const frame = content.parentElement as HTMLElement;
      expect(content.style.transform).toBe('translate(0px) scale(1)');

      await act(async () => {
        fireEvent.wheel(frame, { deltaY: -1, clientX: 0, clientY: 0 });
      });
      expect(content.style.transform).not.toBe('translate(0px) scale(1)');
    });

    // A magnified image pans on a drag, so the corner handles stand down rather
    // than fight the pan for the same pointer.
    it('stands the corner handles down while magnified', async () => {
      await ready();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });
      const handle = screen.getByLabelText('Top-left corner');
      expect(handle).toHaveAttribute('tabindex', '0');

      const content = screen.getByRole('img', {
        name: 'Original photo preview',
      }).parentElement as HTMLElement;
      await act(async () => {
        fireEvent.wheel(content.parentElement as HTMLElement, {
          deltaY: -1,
          clientX: 0,
          clientY: 0,
        });
      });
      expect(screen.getByLabelText('Top-left corner')).toHaveAttribute(
        'tabindex',
        '-1',
      );
    });
  });

  describe('rotating', () => {
    // The original is stored byte-for-byte as the device produced it (`I2`),
    // so only the scan turns. Offering Rotate beside the photo would promise
    // an edit this dialog does not make.
    it('is offered for the scan and not for the photo', async () => {
      // Landscape, so a turn the round trip must not lose is visible in the size.
      worker.result = scanResult({
        enhanced: {
          width: 40,
          height: 20,
          data: new Uint8ClampedArray(40 * 20 * 4),
        },
      });
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );
      const preview = () =>
        // The canvas sits in the zoom transform wrapper; the sized frame that
        // swaps dimensions on a turn is its grandparent.
        screen.getByRole('img', { name: 'Enhanced scan preview' })
          .parentElement?.parentElement as HTMLElement;
      const landscape = preview().style.width;

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
      });
      const turned = preview().style.width;
      expect(turned).not.toBe(landscape);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });
      expect(
        screen.queryByRole('button', { name: 'Rotate' }),
      ).not.toBeInTheDocument();

      // ...and it comes back with the scan, still holding the turn: hiding the
      // control must not quietly discard what it did.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Enhanced' }));
      });
      expect(screen.getByRole('button', { name: 'Rotate' })).toBeInTheDocument();
      expect(preview().style.width).toBe(turned);
    });

    // Rotation used to re-run the scan: ~7.7s per press on a 12MP photo, and
    // four presses queued half a minute to arrive back where you started.
    it('sends nothing to the worker', async () => {
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );
      const before = worker.sent.length;

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
      });

      expect(worker.sent).toHaveLength(before);
      expect(worker.sent.some((r) => r.kind === 'rewarp')).toBe(false);
    });

    it('turns the preview, swapping its dimensions', async () => {
      // A landscape result, so a quarter turn is visible in the size.
      worker.result = scanResult({
        enhanced: {
          width: 40,
          height: 20,
          data: new Uint8ClampedArray(40 * 20 * 4),
        },
      });
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );

      const canvas = () =>
        // The canvas sits in the zoom transform wrapper; the sized frame that
        // swaps dimensions on a turn is its grandparent.
        screen.getByRole('img', { name: 'Enhanced scan preview' })
          .parentElement?.parentElement as HTMLElement;
      const landscape = canvas().style.width;

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
      });

      expect(canvas().style.width).not.toBe(landscape);
      // Two more turns and it is landscape again, three back to portrait.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
      });
      expect(canvas().style.width).toBe(landscape);
    });

    // The upload takes the pixels the preview showed, so a turn has to reach
    // the encoder rather than being a display trick.
    it('encodes the turned image, not the untouched one', async () => {
      const { encodeScan } = await import(
        '@/lib/document-scanner/decode-image'
      );
      worker.result = scanResult({
        enhanced: {
          width: 40,
          height: 20,
          data: new Uint8ClampedArray(40 * 20 * 4),
        },
      });
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Use enhanced' }));
      });

      const passed = vi.mocked(encodeScan).mock.calls.at(-1)?.[0];
      expect(passed).toMatchObject({ width: 20, height: 40 });
    });
  });

  describe('the finish', () => {
    async function ready() {
      const handles = await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );
      return handles;
    }

    it('offers every finish, on the scan alone', async () => {
      await ready();

      const select = screen.getByLabelText('Finish') as HTMLSelectElement;
      expect(
        Array.from(select.options).map((option) => option.value),
      ).toEqual(['colour', 'grayscale', 'blackAndWhite', 'none']);
      expect(select.value).toBe('colour');

      // The photo is stored exactly as taken, so nothing here is offered
      // beside it.
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });
      expect(screen.queryByLabelText('Finish')).not.toBeInTheDocument();
    });

    // The whole reason the warp comes back from the worker: a finish change is
    // one pass over a crop that already exists.
    it('restyles the existing crop rather than warping again', async () => {
      await ready();
      const before = worker.sent.length;

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Finish'), {
          target: { value: 'blackAndWhite' },
        });
      });
      await waitFor(() => expect(worker.sent.length).toBe(before + 1));

      expect(worker.sent[before]).toMatchObject({
        kind: 'restyle',
        style: 'blackAndWhite',
      });
      expect(worker.sent.some((request) => request.kind === 'rewarp')).toBe(
        false,
      );
    });

    it('shows what the chosen finish does', async () => {
      await ready();
      expect(
        screen.getByText(/Evens out the lighting/),
      ).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Finish'), {
          target: { value: 'none' },
        });
      });
      expect(screen.getByText(/exactly as photographed/)).toBeInTheDocument();
    });

    it('remembers the chosen finish for the next document', async () => {
      await ready();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Finish'), {
          target: { value: 'blackAndWhite' },
        });
      });
      expect(useScanSettingsStore.getState().style).toBe('blackAndWhite');
    });

    it('remembers the slider offsets for the next document', async () => {
      await ready();
      // Only the brightness and contrast ranges are sliders here: the corner
      // handles (also role slider) are drawn on the Original view, not this one.
      const [brightness, contrast] = screen.getAllByRole('slider');
      // The offsets persist when the gesture settles (blur/pointer-up), not on
      // every tick, so the store is checked after the drag ends.
      await act(async () => {
        fireEvent.change(brightness, { target: { value: '25' } });
        fireEvent.change(contrast, { target: { value: '-15' } });
        fireEvent.blur(contrast);
      });
      expect(useScanSettingsStore.getState().adjustments).toEqual({
        brightness: 25,
        contrast: -15,
      });
    });

    it('opens a new document in the remembered finish', async () => {
      useScanSettingsStore.setState({
        style: 'blackAndWhite',
        adjustments: NEUTRAL_ADJUSTMENTS,
      });
      await ready();

      expect((screen.getByLabelText('Finish') as HTMLSelectElement).value).toBe(
        'blackAndWhite',
      );
      // The very first scan is produced in the remembered finish, not the
      // default colour, so the preview never flashes the wrong one.
      expect(worker.sent[0]).toMatchObject({
        kind: 'scan',
        style: 'blackAndWhite',
      });
    });

    it('carries the chosen finish into a later corner move', async () => {
      await ready();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Finish'), {
          target: { value: 'grayscale' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Original' }));
      });
      await act(async () => {
        fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
          key: 'ArrowRight',
        });
      });

      await waitFor(() =>
        expect(
          worker.sent.some((request) => request.kind === 'rewarp'),
        ).toBe(true),
      );
      const rewarp = worker.sent.find((request) => request.kind === 'rewarp');
      expect(rewarp).toMatchObject({ style: 'grayscale' });
    });
  });

  describe('brightness and contrast', () => {
    async function ready() {
      // Landscape, so a change in the preview is visible in its size.
      worker.result = scanResult({
        enhanced: {
          width: 40,
          height: 20,
          data: new Uint8ClampedArray(40 * 20 * 4),
        },
      });
      await open();
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Use enhanced' }),
        ).toBeEnabled(),
      );
    }

    it('offers both, starting from the image as produced', async () => {
      await ready();

      expect(screen.getByLabelText('Brightness (0)')).toBeInTheDocument();
      expect(screen.getByLabelText('Contrast (0)')).toBeInTheDocument();
      // Nothing to undo yet.
      expect(
        screen.getByRole('button', { name: 'Reset brightness and contrast' }),
      ).toBeDisabled();
    });

    // A lookup per pixel over pixels that already exist, so it costs no worker
    // round trip at all -- which is what lets the slider move the picture as it
    // is dragged.
    it('applies without asking the worker', async () => {
      await ready();
      const before = worker.sent.length;

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brightness (0)'), {
          target: { value: '40' },
        });
      });

      expect(screen.getByLabelText('Brightness (40)')).toBeInTheDocument();
      expect(worker.sent).toHaveLength(before);
    });

    it('undoes both at once, and only while there is something to undo', async () => {
      await ready();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Contrast (0)'), {
          target: { value: '-25' },
        });
      });
      const reset = screen.getByRole('button', {
        name: 'Reset brightness and contrast',
      });
      expect(reset).toBeEnabled();

      await act(async () => {
        fireEvent.click(reset);
      });

      expect(screen.getByLabelText('Contrast (0)')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: 'Reset brightness and contrast' }),
      ).toBeDisabled();
    });

    // The preview is the file that gets stored (`I3`), so an adjustment that
    // only changed the picture on screen would store the unadjusted one.
    it('encodes the adjusted image, not the one the worker returned', async () => {
      await ready();
      const { encodeScan } = await import(
        '@/lib/document-scanner/decode-image'
      );
      const encode = vi.mocked(encodeScan);
      encode.mockClear();

      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brightness (0)'), {
          target: { value: '100' },
        });
      });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Use enhanced' }));
      });

      const encoded = encode.mock.calls[0][0];
      expect(Array.from(encoded.data.slice(0, 4))).not.toEqual(
        Array.from(worker.result.enhanced.data.slice(0, 4)),
      );
    });

    it('survives a finish change', async () => {
      await ready();
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Brightness (0)'), {
          target: { value: '30' },
        });
      });
      await act(async () => {
        fireEvent.change(screen.getByLabelText('Finish'), {
          target: { value: 'grayscale' },
        });
      });

      await waitFor(() =>
        expect(screen.getByLabelText('Brightness (30)')).toBeInTheDocument(),
      );
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
