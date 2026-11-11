import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { WidgetResizeGrip } from './WidgetResizeGrip';
import type { WidgetHeight, WidgetWidth } from './dashboard-layout';

// Grid 1176 wide with a 24px gap: a column is 76. The item sits at (0, 100).
// Right edges: third 376, half 576, two thirds 776, full 1176.
const GRID_WIDTH = 1176;
const ITEM_TOP = 100;

let frames: FrameRequestCallback[];
// The item's viewport top: a scroll moves it under a still pointer.
let itemTop = ITEM_TOP;
const flush = () => act(() => frames.splice(0).forEach((cb) => cb(0)));

function box(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

function mount(
  id: 'net-worth' | 'favourite-accounts',
  width: WidgetWidth,
  height: WidgetHeight,
  // The item's real height: content and its row's stretch, not its preset.
  itemHeight = 540,
) {
  const onResize = vi.fn();
  const { container } = render(
    <div data-testid="grid">
      <div data-widget-id={id} data-testid="item">
        <div data-testid="card" />
        <WidgetResizeGrip id={id} width={width} height={height} onResize={onResize} />
      </div>
    </div>,
  );
  screen.getByTestId('grid').getBoundingClientRect = () => box(0, 0, GRID_WIDTH, 2000);
  screen.getByTestId('item').getBoundingClientRect = () => box(0, itemTop, 576, itemHeight);
  return { onResize, container };
}

const grip = () => screen.getByRole('button', { name: /^Resize / });
const press = () => fireEvent.pointerDown(grip(), { clientX: 576, clientY: 640, pointerId: 1 });
const moveTo = (x: number, y: number) => {
  fireEvent.pointerMove(grip(), { clientX: x, clientY: y, pointerId: 1 });
  flush();
};
const release = (x: number, y: number) => fireEvent.pointerUp(grip(), { clientX: x, clientY: y, pointerId: 1 });

describe('WidgetResizeGrip', () => {
  beforeEach(() => {
    frames = [];
    itemTop = ITEM_TOP;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
    vi.stubGlobal('cancelAnimationFrame', () => {});
    // Only the grid's style is faked; the rest of the document keeps its own.
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) =>
      (el as HTMLElement).dataset?.testid === 'grid' ? ({ columnGap: '24px' } as CSSStyleDeclaration) : real(el, pseudo),
    );
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('is a named button with a hint, and rings focus only for the keyboard', () => {
    mount('net-worth', 'half', 'standard');
    expect(grip()).toHaveAccessibleName('Resize Net Worth');
    expect(grip()).toHaveAttribute('title', expect.stringContaining('Net Worth'));
    expect(grip().className).toContain('focus-visible:ring-2');
    expect(grip().className).toContain('touch-none');
    expect(grip().className).toContain('motion-reduce:transition-none');
  });

  it('snaps to the preset whose edge is nearest the pointer, on each axis', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    // 700 is nearer 776 (two thirds) than 576; 400 below the top is nearer 390 than 540.
    moveTo(700, ITEM_TOP + 400);
    release(700, ITEM_TOP + 400);
    expect(onResize).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith('net-worth', { width: 'twoThirds', height: 'compact' });
  });

  it('snaps to full width and to auto height at the extremes', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    release(2000, ITEM_TOP + 10);
    expect(onResize).toHaveBeenCalledWith('net-worth', { width: 'full', height: 'auto' });
  });

  it('never offers below the widget minimum: a half-minimum widget dragged narrow stays half', () => {
    // Net Worth's minimum is half; Favourite Accounts may be a third.
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    release(10, ITEM_TOP + 540);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('sends only the dimension that changed', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    release(1100, ITEM_TOP + 540);
    expect(onResize).toHaveBeenCalledWith('net-worth', { width: 'full' });
    onResize.mockClear();
    press();
    release(576, ITEM_TOP + 720);
    expect(onResize).toHaveBeenCalledWith('net-worth', { height: 'tall' });
  });

  it('sends nothing when the drag ends on the current size', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    moveTo(900, ITEM_TOP + 700);
    release(576, ITEM_TOP + 540);
    expect(onResize).not.toHaveBeenCalled();
  });

  describe('an axis the pointer did not move along keeps its preset', () => {
    // An auto-height Favourite Accounts stretched to 540px by its row's neighbour.
    it('a press and release with no movement sends nothing on a stretched item', () => {
      const { onResize } = mount('favourite-accounts', 'half', 'auto', 540);
      press();
      release(576, ITEM_TOP + 540);
      expect(onResize).not.toHaveBeenCalled();
    });

    it('a horizontal-only drag changes only the width', () => {
      const { onResize } = mount('favourite-accounts', 'half', 'auto', 540);
      press();
      moveTo(1100, ITEM_TOP + 542);
      // The outline keeps the item's real height on the axis that did not move.
      expect(screen.getByTestId('widget-resize-preview')).toHaveStyle({ width: '1176px', height: '540px' });
      release(1100, ITEM_TOP + 542);
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith('favourite-accounts', { width: 'full' });
    });

    it('a vertical drag still snaps the height, leaving the width', () => {
      const { onResize } = mount('favourite-accounts', 'half', 'auto', 540);
      press();
      release(578, ITEM_TOP + 720);
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith('favourite-accounts', { height: 'tall' });
    });
  });

  describe('an incidental drift on the other axis does not count', () => {
    it('a sideways drag that drifts 6px down changes only the width', () => {
      // An auto-height item 300px tall, the grip at its corner.
      const { onResize } = mount('net-worth', 'half', 'auto', 300);
      fireEvent.pointerDown(grip(), { clientX: 566, clientY: 390, pointerId: 1 });
      release(1100, 396);
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith('net-worth', { width: 'full' });
    });

    it('a downward drag that drifts 110px sideways changes only the height', () => {
      const { onResize } = mount('net-worth', 'half', 'standard');
      press();
      // 686 alone is nearer two thirds (776) than half (576), but 110 across is small beside 340 down.
      release(686, 980);
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith('net-worth', { height: 'tall' });
    });

    it('a diagonal drag changes both', () => {
      const { onResize } = mount('net-worth', 'half', 'standard');
      press();
      release(776, 790);
      expect(onResize).toHaveBeenCalledWith('net-worth', { width: 'twoThirds', height: 'tall' });
    });
  });

  describe('scrolling during a drag', () => {
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

    it('follows a wheel scroll: the outline moves with the item and the depth is taken from its new top', () => {
      const { onResize } = mount('net-worth', 'half', 'standard');
      press();
      moveTo(576, 600);
      expect(screen.getByTestId('widget-resize-preview')).toHaveStyle({ top: `${ITEM_TOP}px`, height: '540px' });
      // The page scrolls 200px under a still pointer.
      itemTop = ITEM_TOP - 200;
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      flush();
      // 600 is now 700 below the item's top: tall.
      expect(screen.getByTestId('widget-resize-preview')).toHaveStyle({ top: `${ITEM_TOP - 200}px`, height: '720px' });
      release(576, 600);
      expect(onResize).toHaveBeenCalledWith('net-worth', { height: 'tall' });
    });

    it('scrolls the page a step a frame while the pointer is held near the bottom edge, then stops', () => {
      setScroll(500, 3000);
      const { onResize } = mount('net-worth', 'half', 'standard');
      press();
      const bottom = window.innerHeight - 4;
      moveTo(576, bottom);
      expect(scrollBy).toHaveBeenCalledTimes(1);
      expect(scrollBy.mock.calls[0][0]).toBe(0);
      expect(scrollBy.mock.calls[0][1]).toBeGreaterThan(0);
      // The pointer has not moved, but the next frame scrolls again.
      expect(frames).toHaveLength(1);
      flush();
      expect(scrollBy).toHaveBeenCalledTimes(2);
      // Back from the edge: the scrolling stops.
      moveTo(576, 600);
      expect(scrollBy).toHaveBeenCalledTimes(2);
      expect(frames).toHaveLength(0);
      release(576, 600);
      expect(onResize).not.toHaveBeenCalled();
    });

    it('stops scrolling and listening once the drag ends', () => {
      setScroll(500, 3000);
      mount('net-worth', 'half', 'standard');
      press();
      moveTo(576, window.innerHeight - 4);
      release(576, window.innerHeight - 4);
      flush();
      expect(scrollBy).toHaveBeenCalledTimes(1);
      act(() => {
        window.dispatchEvent(new Event('scroll'));
      });
      expect(frames).toHaveLength(0);
    });
  });

  it('shows a dashed outline at the target size while dragging, leaving the card alone', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    expect(screen.queryByTestId('widget-resize-preview')).not.toBeInTheDocument();
    press();
    moveTo(780, ITEM_TOP + 720);
    const preview = screen.getByTestId('widget-resize-preview');
    expect(preview).toHaveAttribute('aria-hidden', 'true');
    expect(preview.className).toContain('pointer-events-none');
    expect(preview.className).toContain('border-dashed');
    expect(preview).toHaveStyle({ left: '0px', top: `${ITEM_TOP}px`, width: '776px', height: '720px' });
    expect(screen.getByTestId('card')).not.toHaveAttribute('style');
    expect(onResize).not.toHaveBeenCalled();
    release(780, ITEM_TOP + 720);
    expect(screen.queryByTestId('widget-resize-preview')).not.toBeInTheDocument();
  });

  it('updates the outline at most once per frame', () => {
    mount('net-worth', 'half', 'standard');
    press();
    frames.length = 0;
    fireEvent.pointerMove(grip(), { clientX: 700, clientY: 300, pointerId: 1 });
    fireEvent.pointerMove(grip(), { clientX: 900, clientY: 300, pointerId: 1 });
    expect(frames).toHaveLength(1);
  });

  it('cancels on Escape without a resize, and the Escape is claimed', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    moveTo(1100, ITEM_TOP + 720);
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => {
      window.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByTestId('widget-resize-preview')).not.toBeInTheDocument();
    release(1100, ITEM_TOP + 720);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('cancels on pointercancel without a resize', () => {
    const { onResize } = mount('net-worth', 'half', 'standard');
    press();
    moveTo(1100, ITEM_TOP + 720);
    fireEvent.pointerCancel(grip(), { pointerId: 1 });
    expect(screen.queryByTestId('widget-resize-preview')).not.toBeInTheDocument();
    release(1100, ITEM_TOP + 720);
    expect(onResize).not.toHaveBeenCalled();
  });

  it('steps the width and height one preset per arrow key', () => {
    const { onResize } = mount('net-worth', 'twoThirds', 'standard');
    fireEvent.keyDown(grip(), { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { width: 'full' });
    fireEvent.keyDown(grip(), { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { width: 'half' });
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { height: 'tall' });
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(onResize).toHaveBeenLastCalledWith('net-worth', { height: 'compact' });
    expect(onResize).toHaveBeenCalledTimes(4);
  });

  it('stops at the ends of each list', () => {
    const { onResize } = mount('net-worth', 'half', 'auto');
    fireEvent.keyDown(grip(), { key: 'ArrowLeft' });
    fireEvent.keyDown(grip(), { key: 'ArrowUp' });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('stops at the widest and the tallest', () => {
    const { onResize } = mount('net-worth', 'full', 'tall');
    fireEvent.keyDown(grip(), { key: 'ArrowRight' });
    fireEvent.keyDown(grip(), { key: 'ArrowDown' });
    expect(onResize).not.toHaveBeenCalled();
  });
});
