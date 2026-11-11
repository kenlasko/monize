import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { AUTO_SCROLL_EDGE, useGridReorder } from './useGridReorder';

const mockWide = vi.hoisted(() => ({ value: true }));
vi.mock('@/hooks/useIsMobile', () => ({
  useIsLgUp: () => mockWide.value,
}));

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Wide: two rows of a 12-column grid, three thirds then two thirds.
const WIDE: Box[] = [
  { left: 0, top: 100, right: 300, bottom: 300 },
  { left: 324, top: 100, right: 624, bottom: 300 },
  { left: 648, top: 100, right: 948, bottom: 300 },
  { left: 0, top: 324, right: 300, bottom: 524 },
  { left: 324, top: 324, right: 624, bottom: 524 },
];
// Narrow: one column of four.
const NARROW: Box[] = [0, 1, 2, 3].map((i) => ({ left: 0, top: 100 + i * 124, right: 500, bottom: 200 + i * 124 }));

let frames: FrameRequestCallback[];
const flush = () =>
  act(() => {
    frames.splice(0).forEach((cb) => cb(0));
  });

let container: HTMLDivElement;
let readCount: number;

function mountGrid(rects: Box[]) {
  container = document.createElement('div');
  readCount = 0;
  rects.forEach((r, i) => {
    const el = document.createElement('div');
    el.setAttribute('data-widget-id', `w${i}`);
    el.getBoundingClientRect = () => {
      readCount += 1;
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON: () => r };
    };
    container.appendChild(el);
  });
  // The trailing Add tile is not an item.
  container.appendChild(document.createElement('button'));
  document.body.appendChild(container);
}

function setup(rects: Box[], enabled = true) {
  mountGrid(rects);
  const onMove = vi.fn();
  const hook = renderHook(
    ({ on }: { on: boolean }) =>
      useGridReorder({ containerRef: { current: container }, count: rects.length, enabled: on, onMove }),
    { initialProps: { on: enabled } },
  );
  return { ...hook, onMove };
}

type Hook = ReturnType<typeof setup>['result'];

/** Press item `index`'s grip at (x, y), as DragHandle and the overlay's wrapper report it. */
function press(result: Hook, index: number, x: number, y: number) {
  act(() => {
    result.current.grip(index).onPress(x, y);
    result.current.grip(index).onDragStart();
  });
  return {
    moveTo: (px: number, py: number) => {
      act(() => result.current.grip(index).onDragMove(px - x, py - y));
      flush();
    },
    releaseAt: (px: number, py: number) => act(() => result.current.grip(index).onDragEnd(px - x, py - y)),
  };
}

const indicators = (result: Hook, count: number) =>
  Array.from({ length: count }, (_, i) => result.current.dropIndicator(i));

describe('useGridReorder', () => {
  beforeEach(() => {
    mockWide.value = true;
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {
      frames = [];
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    container.remove();
  });

  describe('at lg and up, where the grid flows in rows', () => {
    it('takes the gap by which horizontal half of the item under the pointer it is in', () => {
      const { result } = setup(WIDE);
      expect(result.current.axis).toBe('x');
      const drag = press(result, 0, 150, 200);
      // Right half of item 1: the gap after it, drawn before item 2.
      drag.moveTo(500, 290);
      expect(result.current.draggingIndex).toBe(0);
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
      // Left half of item 4, low in its rectangle: the vertical position does not matter.
      drag.moveTo(400, 520);
      expect(indicators(result, 5)).toEqual([null, null, null, null, 'before']);
      // Right half of the last item: after it.
      drag.moveTo(500, 450);
      expect(indicators(result, 5)).toEqual([null, null, null, null, 'after']);
    });

    it('takes the nearest item when the pointer is in a gutter or past the grid', () => {
      const { result } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      // In the gutter between items 1 and 2, nearer item 2's left edge.
      drag.moveTo(640, 200);
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
      // Below row 1 where row 2 ends short: item 2 is nearest, its right half.
      drag.moveTo(900, 400);
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
      // Far below the grid, under item 3's left half.
      drag.moveTo(50, 700);
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
    });

    it('moves once on release, forward past several items, to its place after the removal', () => {
      const { result, onMove } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 450);
      drag.releaseAt(500, 450);
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove).toHaveBeenCalledWith(0, 4, 'pointer');
      expect(result.current.draggingIndex).toBeNull();
      expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
    });

    it('moves backward to the front', () => {
      const { result, onMove } = setup(WIDE);
      const drag = press(result, 4, 474, 424);
      drag.moveTo(50, 200);
      expect(indicators(result, 5)).toEqual(['before', null, null, null, null]);
      drag.releaseAt(50, 200);
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove).toHaveBeenCalledWith(4, 0, 'pointer');
    });

    it('uses the release point even when no frame ran after the last move', () => {
      const { result, onMove } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 200);
      drag.releaseAt(800, 200);
      expect(onMove).toHaveBeenCalledWith(0, 2, 'pointer');
    });
  });

  describe('below lg, where the grid is one column', () => {
    it('takes the gap by which vertical half of the item the pointer is in', () => {
      mockWide.value = false;
      const { result, onMove } = setup(NARROW);
      expect(result.current.axis).toBe('y');
      const drag = press(result, 3, 250, 522);
      // Top half of item 1, though on its right side: before it.
      drag.moveTo(450, 240);
      expect(indicators(result, 4)).toEqual([null, 'before', null, null]);
      // Bottom half of item 1: before item 2.
      drag.moveTo(50, 320);
      expect(indicators(result, 4)).toEqual([null, null, 'before', null]);
      drag.releaseAt(50, 240);
      expect(onMove).toHaveBeenCalledTimes(1);
      expect(onMove).toHaveBeenCalledWith(3, 1, 'pointer');
    });
  });

  it('shows no line and moves nothing for the gaps either side of the dragged item', () => {
    const { result, onMove } = setup(WIDE);
    const drag = press(result, 1, 474, 200);
    for (const [x, y] of [
      [200, 200], // item 0's right half: gap 1, before the dragged item
      [500, 200], // its own right half: gap 2
      [700, 200], // item 2's left half: gap 2 again
    ]) {
      drag.moveTo(x, y);
      expect(result.current.draggingIndex).toBe(1);
      expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
    }
    drag.releaseAt(700, 200);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('updates once a frame, however many moves arrive in it', () => {
    const { result } = setup(WIDE);
    press(result, 0, 150, 200);
    act(() => {
      result.current.grip(0).onDragMove(300, 0);
      result.current.grip(0).onDragMove(350, 0);
      result.current.grip(0).onDragMove(650, 0);
    });
    expect(frames).toHaveLength(1);
    expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
    flush();
    // The latest move only: (800, 200) is item 2's right half.
    expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
  });

  it('treats a press that did not travel as no drag at all', () => {
    const { result, onMove } = setup(WIDE);
    const drag = press(result, 0, 150, 200);
    act(() => result.current.grip(0).onDragMove(1, 2));
    expect(frames).toHaveLength(0);
    expect(result.current.draggingIndex).toBeNull();
    drag.releaseAt(151, 202);
    expect(onMove).not.toHaveBeenCalled();
  });

  it('places the chip at the pointer, writing its transform rather than rendering', () => {
    const { result } = setup(WIDE);
    const drag = press(result, 0, 150, 200);
    drag.moveTo(500, 210);
    const chip = document.createElement('div');
    act(() => result.current.chipRef(chip));
    expect(chip.style.transform).toBe('translate3d(512px, 222px, 0)');
    drag.moveTo(520, 230);
    expect(chip.style.transform).toBe('translate3d(532px, 242px, 0)');
  });

  describe('cancelling', () => {
    it('cancels on Escape, moving nothing and keeping that Escape from edit mode', () => {
      const { result, onMove } = setup(WIDE);
      const editModeEscape = vi.fn();
      document.addEventListener('keydown', editModeEscape);
      try {
        const drag = press(result, 0, 150, 200);
        drag.moveTo(500, 200);
        expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
        const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        act(() => {
          document.body.dispatchEvent(escape);
        });
        expect(escape.defaultPrevented).toBe(true);
        expect(editModeEscape).not.toHaveBeenCalled();
        expect(result.current.draggingIndex).toBeNull();
        expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
        // DragHandle still reports the release; it moves nothing.
        drag.releaseAt(500, 200);
        expect(onMove).not.toHaveBeenCalled();

        // With no drag under way, Escape is edit mode's again.
        const next = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        document.body.dispatchEvent(next);
        expect(next.defaultPrevented).toBe(false);
        expect(editModeEscape).toHaveBeenCalledTimes(1);
      } finally {
        document.removeEventListener('keydown', editModeEscape);
      }
    });

    it('cancels on a cancelled pointer, which DragHandle then reports as an end', () => {
      const { result, onMove } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 200);
      act(() => result.current.grip(0).onCancel());
      expect(result.current.draggingIndex).toBeNull();
      drag.releaseAt(500, 200);
      expect(onMove).not.toHaveBeenCalled();
    });

    it('drops a drag under way when edit mode is left, leaving no frame or listener', () => {
      const { result, onMove, rerender } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      act(() => result.current.grip(0).onDragMove(350, 0));
      expect(frames).toHaveLength(1);
      rerender({ on: false });
      expect(frames).toHaveLength(0);
      expect(result.current.draggingIndex).toBeNull();
      expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
      drag.releaseAt(500, 200);
      expect(onMove).not.toHaveBeenCalled();
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.body.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    });

    it('leaves no frame or listener when unmounted mid-drag', () => {
      const { result, unmount } = setup(WIDE);
      press(result, 0, 150, 200);
      act(() => result.current.grip(0).onDragMove(350, 0));
      unmount();
      expect(frames).toHaveLength(0);
      const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      document.body.dispatchEvent(escape);
      expect(escape.defaultPrevented).toBe(false);
    });
  });

  describe('auto-scroll', () => {
    const scrollBy = vi.fn();
    const setScroll = (scrollY: number, scrollHeight: number) => {
      Object.defineProperty(window, 'scrollY', { configurable: true, value: scrollY });
      Object.defineProperty(document.documentElement, 'scrollHeight', { configurable: true, value: scrollHeight });
      if (document.scrollingElement && document.scrollingElement !== document.documentElement) {
        Object.defineProperty(document.scrollingElement, 'scrollHeight', { configurable: true, value: scrollHeight });
      }
    };
    beforeEach(() => {
      scrollBy.mockReset();
      vi.stubGlobal('scrollBy', scrollBy);
    });
    afterEach(() => setScroll(0, 0));

    it('scrolls down a step a frame while the pointer is held near the bottom, re-reading the items', () => {
      setScroll(500, 3000);
      const { result } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      const bottom = window.innerHeight - 4;
      drag.moveTo(150, bottom);
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy.mock.calls[0][0]).toBe(0);
      expect(scrollBy.mock.calls[0][1]).toBeGreaterThan(0);
      const reads = readCount;
      // The pointer has not moved, but the next frame scrolls again.
      expect(frames).toHaveLength(1);
      flush();
      expect(scrollBy).toHaveBeenCalledTimes(2);
      expect(readCount).toBe(reads + WIDE.length);
      // Back in the middle: the scrolling stops.
      drag.moveTo(150, 400);
      flush();
      expect(scrollBy).toHaveBeenCalledTimes(2);
      expect(frames).toHaveLength(0);
    });

    it('scrolls up near the top, further the nearer the edge', () => {
      setScroll(500, 3000);
      const { result } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(150, AUTO_SCROLL_EDGE - 10);
      const shallow = scrollBy.mock.calls[0][1];
      drag.moveTo(150, 2);
      const deep = scrollBy.mock.calls.at(-1)![1];
      expect(shallow).toBeLessThan(0);
      expect(deep).toBeLessThan(shallow);
    });

    it('does not scroll past the top or the bottom of the page', () => {
      setScroll(0, 3000);
      const { result } = setup(WIDE);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(150, 10);
      expect(scrollBy).not.toHaveBeenCalled();
      setScroll(3000 - window.innerHeight, 3000);
      drag.moveTo(150, window.innerHeight - 10);
      expect(scrollBy).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
    });
  });

  describe('a scroll the reader makes during a drag (wheel, trackpad)', () => {
    const wheel = (rects: Box[], dy: number) => {
      for (const r of rects) {
        r.top -= dy;
        r.bottom -= dy;
      }
      window.dispatchEvent(new Event('scroll'));
    };

    it('re-reads the items and tests the next frame and the drop against where they are now', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result, onMove } = setup(rects);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 200);
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
      // Row 2 scrolls up under the still pointer: it is now over item 4's right half.
      act(() => wheel(rects, 224));
      flush();
      expect(indicators(result, 5)).toEqual([null, null, null, null, 'after']);
      drag.releaseAt(500, 200);
      expect(onMove).toHaveBeenCalledWith(0, 4, 'pointer');
    });

    it('stops listening once the drag ends', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result } = setup(rects);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 200);
      drag.releaseAt(500, 200);
      const reads = readCount;
      act(() => wheel(rects, 224));
      expect(readCount).toBe(reads);
      expect(frames).toHaveLength(0);
    });
  });

  describe('arrow keys on the grip', () => {
    it('move one place per key, Left and Up earlier, Right and Down later', () => {
      const { result, onMove } = setup(WIDE);
      act(() => result.current.grip(2).onNudge(-24, 0));
      expect(onMove).toHaveBeenLastCalledWith(2, 1, 'keyboard');
      act(() => result.current.grip(2).onNudge(0, -24));
      expect(onMove).toHaveBeenLastCalledWith(2, 1, 'keyboard');
      act(() => result.current.grip(2).onNudge(24, 0));
      expect(onMove).toHaveBeenLastCalledWith(2, 3, 'keyboard');
      act(() => result.current.grip(2).onNudge(0, 24));
      expect(onMove).toHaveBeenLastCalledWith(2, 3, 'keyboard');
      expect(onMove).toHaveBeenCalledTimes(4);
    });

    it('stop at the ends', () => {
      const { result, onMove } = setup(WIDE);
      act(() => result.current.grip(0).onNudge(-24, 0));
      act(() => result.current.grip(0).onNudge(0, -24));
      act(() => result.current.grip(4).onNudge(24, 0));
      act(() => result.current.grip(4).onNudge(0, 24));
      expect(onMove).not.toHaveBeenCalled();
    });
  });
});
