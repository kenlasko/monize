import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';

import { DocumentCornerHandles } from './DocumentCornerHandles';
import type { Quad } from '@/lib/document-scanner/document-scan.types';

/**
 * The corner handles, which are the repair for a detection that went wrong in
 * a way retaking the photo would not fix.
 *
 * Two things they must get right and one they must refuse: corners are edited
 * in SOURCE pixels while being drawn at DISPLAY size, a drag re-warps once
 * rather than per pointer event, and a corner dragged across its neighbour is
 * rejected instead of producing a folded image.
 */

/** A square page at 400x400, displayed at half size. */
const QUAD: Quad = [
  { x: 100, y: 100 },
  { x: 300, y: 100 },
  { x: 300, y: 300 },
  { x: 100, y: 300 },
];

function renderHandles(overrides: Partial<Parameters<typeof DocumentCornerHandles>[0]> = {}) {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <DocumentCornerHandles
      quad={QUAD}
      imageWidth={400}
      imageHeight={400}
      displayWidth={200}
      displayHeight={200}
      onChange={onChange}
      onCommit={onCommit}
      {...overrides}
    />,
  );
  return { onChange, onCommit };
}

/** The four handles, in the fixed top-left/top-right/bottom-right/bottom-left order. */
function handles(): HTMLElement[] {
  return screen.getAllByRole('slider');
}

describe('DocumentCornerHandles', () => {
  it('draws a handle per corner, each named', () => {
    renderHandles();

    expect(handles()).toHaveLength(4);
    expect(screen.getByLabelText('Top-left corner')).toBeInTheDocument();
    expect(screen.getByLabelText('Bottom-right corner')).toBeInTheDocument();
  });

  // The photo is shown scaled to fit the dialog, so a handle at source (100,100)
  // sits at display (50,50). Drawing at source coordinates would put every
  // handle off the image.
  it('positions handles in display coordinates', () => {
    renderHandles();

    const topLeft = screen.getByLabelText('Top-left corner');
    expect(topLeft.getAttribute('cx')).toBe('50');
    expect(topLeft.getAttribute('cy')).toBe('50');
  });

  it('reports the corner position in source pixels', () => {
    renderHandles();
    expect(
      screen.getByLabelText('Top-left corner').getAttribute('aria-valuenow'),
    ).toBe('100');
  });

  describe('keyboard nudging', () => {
    it('moves a corner and re-warps once', () => {
      const { onChange, onCommit } = renderHandles();

      fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
        key: 'ArrowRight',
      });

      expect(onChange).toHaveBeenCalledTimes(1);
      const moved = onChange.mock.calls[0][0] as Quad;
      expect(moved[0]).toEqual({ x: 104, y: 100 });
      // The other corners are untouched.
      expect(moved[1]).toEqual(QUAD[1]);
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it('takes a larger step with Shift held', () => {
      const { onChange } = renderHandles();

      fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
        key: 'ArrowDown',
        shiftKey: true,
      });

      expect((onChange.mock.calls[0][0] as Quad)[0]).toEqual({
        x: 100,
        y: 124,
      });
    });

    it('ignores keys that are not arrows', () => {
      const { onChange, onCommit } = renderHandles();
      fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
        key: 'Enter',
      });
      expect(onChange).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    });

    // A corner nudged off the image would make the warp sample outside the
    // photo, which OpenCV fills with a border the user cannot remove.
    it('clamps a corner to the image rather than letting it leave', () => {
      const { onChange } = renderHandles({
        quad: [
          { x: 2, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 300 },
          { x: 100, y: 300 },
        ],
      });

      fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
        key: 'ArrowLeft',
      });

      expect((onChange.mock.calls[0][0] as Quad)[0]).toEqual({ x: 0, y: 100 });
    });

    // A bow tie is accepted by getPerspectiveTransform and comes back folded,
    // so it is refused here rather than discovered in the preview.
    it('refuses a move that folds the quadrilateral', () => {
      const { onChange, onCommit } = renderHandles({
        // Top-left already sits just left of top-right; one large step crosses it.
        quad: [
          { x: 290, y: 100 },
          { x: 300, y: 100 },
          { x: 300, y: 300 },
          { x: 100, y: 300 },
        ],
      });

      fireEvent.keyDown(screen.getByLabelText('Top-left corner'), {
        key: 'ArrowRight',
        shiftKey: true,
      });

      expect(onChange).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    });
  });

  describe('dragging', () => {
    it('re-warps once on release, not on every pointer move', () => {
      const { onCommit } = renderHandles();
      const handle = screen.getByLabelText('Top-left corner');
      // jsdom does not implement pointer capture.
      handle.setPointerCapture = vi.fn();
      handle.hasPointerCapture = vi.fn(() => true);
      handle.releasePointerCapture = vi.fn();

      fireEvent.pointerDown(handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 60, clientY: 60 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 70, clientY: 70 });
      expect(onCommit).not.toHaveBeenCalled();

      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    // Without capture a fast drag stops the moment the pointer outruns the
    // circle, which feels like the handle sticking.
    it('captures the pointer so a fast drag keeps tracking', () => {
      renderHandles();
      const handle = screen.getByLabelText('Top-left corner');
      const capture = vi.fn();
      handle.setPointerCapture = capture;

      fireEvent.pointerDown(handle, { pointerId: 7 });

      expect(capture).toHaveBeenCalledWith(7);
    });

    it('ignores a pointer move when nothing is being dragged', () => {
      const { onChange } = renderHandles();
      fireEvent.pointerMove(screen.getByLabelText('Top-left corner'), {
        pointerId: 1,
        clientX: 10,
        clientY: 10,
      });
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  describe('when disabled', () => {
    it('takes no input and leaves nothing focusable', () => {
      const { onChange, onCommit } = renderHandles({ disabled: true });
      const handle = screen.getByLabelText('Top-left corner');

      expect(handle.getAttribute('tabindex')).toBe('-1');
      fireEvent.keyDown(handle, { key: 'ArrowRight' });
      fireEvent.pointerDown(handle, { pointerId: 1 });

      expect(onChange).not.toHaveBeenCalled();
      expect(onCommit).not.toHaveBeenCalled();
    });
  });
});
