import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { AUTO_SCROLL_EDGE, gapAt, useGridReorder } from './useGridReorder';

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
// The plan's section 8 flow at 1440px: A twoThirds; B half, C third; D third, E third.
// Rows 1 and 2 end short, so the right of each is empty grid.
const SECTION_8: Box[] = [
  { left: 48, top: 100, right: 936, bottom: 400 },
  { left: 48, top: 424, right: 708, bottom: 724 },
  { left: 732, top: 424, right: 1164, bottom: 724 },
  { left: 48, top: 748, right: 480, bottom: 1048 },
  { left: 504, top: 748, right: 936, bottom: 1048 },
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
      // In row 2's band, past its last item: the end of row 2, which is the end.
      drag.moveTo(900, 400);
      expect(indicators(result, 5)).toEqual([null, null, null, null, 'after']);
      // In the gutter between the rows, nearer row 2: the gap before item 3.
      drag.moveTo(50, 318);
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
      // Far below the grid, under item 3's left half.
      drag.moveTo(50, 700);
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
    });

    describe('rows that end short (the plan, section 8)', () => {
      it('takes the row the pointer is level with, then the gap by x within that row', () => {
        // The empty end of row 1, level with A: after A, though C is nearer in a straight line.
        expect(gapAt(SECTION_8, 1176, 250, 'x')).toBe(1);
        // Past E in row 3, below C's corner: the end of the layout.
        expect(gapAt(SECTION_8, 1150, 898, 'x')).toBe(5);
        // Within row 2: left of B's centre, between B and C, past C.
        expect(gapAt(SECTION_8, 300, 600, 'x')).toBe(1);
        expect(gapAt(SECTION_8, 720, 600, 'x')).toBe(2);
        expect(gapAt(SECTION_8, 1300, 600, 'x')).toBe(3);
      });

      it('takes the nearer row from a gutter between rows, and the end row above or below the grid', () => {
        // The 24px gutter between rows 1 and 2, nearer row 1, then nearer row 2.
        expect(gapAt(SECTION_8, 1176, 405, 'x')).toBe(1);
        expect(gapAt(SECTION_8, 1176, 420, 'x')).toBe(3);
        // Above the first row: row 1 by x.
        expect(gapAt(SECTION_8, 20, 10, 'x')).toBe(0);
        expect(gapAt(SECTION_8, 1300, 10, 'x')).toBe(1);
        // Below the last row: row 3 by x.
        expect(gapAt(SECTION_8, 20, 1400, 'x')).toBe(3);
        expect(gapAt(SECTION_8, 600, 1400, 'x')).toBe(4);
        expect(gapAt(SECTION_8, 1300, 1400, 'x')).toBe(5);
      });

      it('is null with no items', () => {
        expect(gapAt([], 10, 10, 'x')).toBeNull();
        expect(gapAt([], 10, 10, 'y')).toBeNull();
      });

      it('drops E into the empty end of row 1, right after A', () => {
        const { result, onMove } = setup(SECTION_8);
        const drag = press(result, 4, 720, 898);
        drag.moveTo(1176, 250);
        expect(indicators(result, 5)).toEqual([null, 'before', null, null, null]);
        drag.releaseAt(1176, 250);
        expect(onMove).toHaveBeenCalledTimes(1);
        expect(onMove).toHaveBeenCalledWith(4, 1, 'pointer');
      });

      it('leaves E where it is when dropped past it at the end of row 3', () => {
        const { result, onMove } = setup(SECTION_8);
        const drag = press(result, 4, 720, 898);
        drag.moveTo(1150, 898);
        expect(result.current.draggingIndex).toBe(4);
        expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
        drag.releaseAt(1150, 898);
        expect(onMove).not.toHaveBeenCalled();
      });
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

  describe('a layout shift during a drag that is not a scroll', () => {
    it('tests the next frame and the drop against the items as they are now, not as pressed', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result, onMove } = setup(rects);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(140, 400);
      // Row 2, item 3's left half: before item 3.
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
      // A widget in row 1 finishes loading and the row grows by 224px, pushing row 2 down.
      rects.forEach((r, i) => {
        if (i < 3) r.bottom += 224;
        else {
          r.top += 224;
          r.bottom += 224;
        }
      });
      // The pointer is now over the dragged item's own left half: no line, no move.
      drag.moveTo(141, 400);
      expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
      drag.releaseAt(141, 400);
      expect(onMove).not.toHaveBeenCalled();
    });

    it('re-reads on release even when no frame ran after the shift', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result, onMove } = setup(rects);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(140, 400);
      rects.forEach((r, i) => {
        if (i < 3) r.bottom += 224;
        else {
          r.top += 224;
          r.bottom += 224;
        }
      });
      drag.releaseAt(140, 400);
      expect(onMove).not.toHaveBeenCalled();
    });

    it('follows the flow axis when the viewport crosses lg mid-drag (a tablet turned 1024 to 768)', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result, onMove, rerender } = setup(rects);
      const drag = press(result, 3, 150, 424);
      drag.moveTo(500, 200);
      expect(result.current.axis).toBe('x');
      // The grid becomes one column: item i at top 100 + 124i, 500 wide.
      rects.forEach((r, i) => Object.assign(r, NARROW[i] ?? { left: 0, top: 596, right: 500, bottom: 696 }));
      mockWide.value = false;
      rerender({ on: true });
      flush();
      expect(result.current.axis).toBe('y');
      // Item 1's bottom half, on its left: the column's rule, against the items as they are now.
      drag.moveTo(50, 300);
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
      // Item 1's top half but its right side: the column's rule puts it before item 1,
      // where the row rule would put it after.
      drag.moveTo(450, 240);
      expect(indicators(result, 5)).toEqual([null, 'before', null, null, null]);
      drag.releaseAt(450, 240);
      expect(onMove).toHaveBeenCalledWith(3, 1, 'pointer');
    });

    it('takes the gap again on a window resize with a still pointer, and stops listening after', () => {
      const rects = WIDE.map((r) => ({ ...r }));
      const { result } = setup(rects);
      const drag = press(result, 0, 150, 200);
      drag.moveTo(500, 200);
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
      // A narrower window: the thirds shrink to 150px, so x 500 is past row 1's last item.
      rects.slice(0, 3).forEach((r, i) => Object.assign(r, { left: i * 174, right: i * 174 + 150 }));
      act(() => {
        window.dispatchEvent(new Event('resize'));
      });
      flush();
      expect(indicators(result, 5)).toEqual([null, null, null, 'before', null]);
      drag.releaseAt(500, 200);
      window.dispatchEvent(new Event('resize'));
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

  describe('gap slots (the empty ends of short rows, from lg up)', () => {
    // SECTION_8's two slots: the third after A (gap 1) and the third after E (gap 5).
    const SLOTS = [
      { index: 1, width: 'third', box: { left: 960, top: 100, right: 1392, bottom: 400 } },
      { index: 5, width: 'third', box: { left: 960, top: 748, right: 1392, bottom: 1048 } },
    ];
    // A and B are at least half wide; C, D and E can be a third.
    const MIN_THIRD = [false, false, true, true, true];

    function setupWithSlots(withFits = true) {
      mountGrid(SECTION_8);
      SLOTS.forEach(({ index, width, box }) => {
        const el = document.createElement('button');
        el.dataset.gapIndex = String(index);
        el.dataset.gapWidth = width;
        el.getBoundingClientRect = () =>
          ({ ...box, x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }) as DOMRect;
        container.appendChild(el);
      });
      const onMove = vi.fn();
      const onSlotDrop = vi.fn();
      const fitsSlot = vi.fn((from: number, width: string) => width !== 'third' || MIN_THIRD[from]);
      const hook = renderHook(() =>
        useGridReorder({
          containerRef: { current: container },
          count: SECTION_8.length,
          enabled: true,
          onMove,
          fitsSlot: withFits ? fitsSlot : undefined,
          onSlotDrop,
        }),
      );
      return { ...hook, onMove, onSlotDrop, fitsSlot };
    }

    it('targets a slot the dragged widget can be that narrow for, with no line, and drops into it', () => {
      const { result, onMove, onSlotDrop } = setupWithSlots();
      // D, from row 3, onto the third left after A.
      const drag = press(result, 3, 264, 898);
      drag.moveTo(1176, 250);
      expect(result.current.slotTarget).toBe(1);
      expect(indicators(result, 5)).toEqual([null, null, null, null, null]);
      drag.releaseAt(1176, 250);
      expect(onSlotDrop).toHaveBeenCalledTimes(1);
      expect(onSlotDrop).toHaveBeenCalledWith(3, 1, 'third');
      expect(onMove).not.toHaveBeenCalled();
      expect(result.current.slotTarget).toBeNull();
    });

    it('lets go of the slot when the pointer leaves it', () => {
      const { result } = setupWithSlots();
      const drag = press(result, 3, 264, 898);
      drag.moveTo(1176, 250);
      expect(result.current.slotTarget).toBe(1);
      drag.moveTo(720, 600);
      expect(result.current.slotTarget).toBeNull();
      expect(indicators(result, 5)).toEqual([null, null, 'before', null, null]);
    });

    it('does not target a slot narrower than the widget can be: the row-band rule decides', () => {
      const { result, onMove, onSlotDrop } = setupWithSlots();
      // B (at least half) over the third after E: the end of row 3, at B's own width.
      const drag = press(result, 1, 300, 600);
      drag.moveTo(1176, 898);
      expect(result.current.slotTarget).toBeNull();
      expect(indicators(result, 5)).toEqual([null, null, null, null, 'after']);
      drag.releaseAt(1176, 898);
      expect(onSlotDrop).not.toHaveBeenCalled();
      expect(onMove).toHaveBeenCalledWith(1, 4, 'pointer');
    });

    it('does not target the end of the dragged widget\'s own row', () => {
      const { result, onMove, onSlotDrop } = setupWithSlots();
      const drag = press(result, 4, 720, 898);
      drag.moveTo(1176, 898);
      expect(result.current.slotTarget).toBeNull();
      drag.releaseAt(1176, 898);
      expect(onSlotDrop).not.toHaveBeenCalled();
      expect(onMove).not.toHaveBeenCalled();
    });

    it('treats slots as empty grid when the caller says nothing about fit', () => {
      const { result, onMove, onSlotDrop } = setupWithSlots(false);
      const drag = press(result, 3, 264, 898);
      drag.moveTo(1176, 250);
      expect(result.current.slotTarget).toBeNull();
      drag.releaseAt(1176, 250);
      expect(onSlotDrop).not.toHaveBeenCalled();
      expect(onMove).toHaveBeenCalledWith(3, 1, 'pointer');
    });
  });
});
