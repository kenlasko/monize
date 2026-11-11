import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { WidgetResizeGrip } from './WidgetResizeGrip';
import type { WidgetHeight, WidgetWidth } from './dashboard-layout';

// Grid 1176 wide with a 24px gap: a column is 76. The item sits at (0, 100).
// Right edges: third 376, half 576, two thirds 776, full 1176.
const GRID_WIDTH = 1176;
const ITEM_TOP = 100;

let frames: FrameRequestCallback[];
const flush = () => act(() => frames.splice(0).forEach((cb) => cb(0)));

function box(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
}

function mount(id: 'net-worth' | 'favourite-accounts', width: WidgetWidth, height: WidgetHeight) {
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
  screen.getByTestId('item').getBoundingClientRect = () => box(0, ITEM_TOP, 576, 540);
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
    const { onResize } = mount('favourite-accounts', 'half', 'standard');
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
    const { onResize } = mount('favourite-accounts', 'half', 'auto');
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
