import { describe, it, expect, vi } from 'vitest';
import { act, screen, fireEvent, within } from '@testing-library/react';
import { render } from '@/test/render';
import {
  EntitySwitcher,
  MENU_WIDTH,
  VIEWPORT_MARGIN,
  placeMenu,
  type EntitySwitcherItem,
} from './EntitySwitcher';

// The pointer decides whether the filter is focused on open (a finger would
// get the keyboard over the list); flipped per test below.
const touch = { current: false };
vi.mock('@/lib/touch-device', () => ({
  isTouchDevice: () => touch.current,
}));

const LABELS = {
  triggerLabel: 'Switch thing',
  filterPlaceholder: 'Filter things...',
  noMatchesLabel: 'No things match',
};

function item(id: string, primary: string, secondary?: string): EntitySwitcherItem {
  return { id, primary, secondary };
}

/** More than the filter threshold of 8, so the box appears. */
function many(count: number): EntitySwitcherItem[] {
  return Array.from({ length: count }, (_, index) =>
    item(`item-${index}`, `Thing number ${index}`),
  );
}

const two = [item('item-1', 'Alpha'), item('item-2', 'Beta')];

function open(items: EntitySwitcherItem[], currentId = 'item-1') {
  const onSelect = vi.fn();
  render(
    <EntitySwitcher
      currentId={currentId}
      items={items}
      onSelect={onSelect}
      {...LABELS}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
  return { onSelect };
}

describe('EntitySwitcher', () => {
  it('renders nothing when there is nowhere else to go', () => {
    render(
      <EntitySwitcher
        currentId="item-1"
        items={[two[0]]}
        onSelect={vi.fn()}
        {...LABELS}
      />,
    );
    expect(screen.queryByRole('button', { name: LABELS.triggerLabel })).toBeNull();
  });

  it('lists the others, not the current one', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Alpha/ })).toBeNull();
  });

  it('selects an entity and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /Beta/ }));
    expect(onSelect).toHaveBeenCalledWith('item-2');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('hides the filter for a short list', () => {
    open(two);
    expect(screen.queryByPlaceholderText(LABELS.filterPlaceholder)).toBeNull();
  });

  it('matches searchText rather than the visible label when one is given', () => {
    const onSelect = vi.fn();
    const items = [
      ...many(9),
      { id: 'sec-1', primary: 'AAPL', secondary: 'Apple Inc.', searchText: 'AAPL Apple Inc.' },
    ];
    render(
      <EntitySwitcher currentId="item-0" items={items} onSelect={onSelect} {...LABELS} />,
    );
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'apple' },
    });
    // "apple" appears only in the secondary text, which `primary` alone would miss.
    expect(screen.getByRole('menuitem', { name: /AAPL/ })).toBeInTheDocument();
  });

  it('says when nothing matches the filter', () => {
    open(many(12), 'item-0');
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'zzz' },
    });
    expect(screen.getByText(LABELS.noMatchesLabel)).toBeInTheDocument();
  });

  it('clears the filter when it closes, so reopening shows the whole list', () => {
    open(many(12), 'item-0');
    fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
      target: { value: 'number 7' },
    });
    // Close via the caret, then reopen.
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
    expect(screen.getByRole('menuitem', { name: /Thing number 3/ })).toBeInTheDocument();
  });

  describe('showCurrent', () => {
    function openShowingCurrent(items: EntitySwitcherItem[], currentId: string) {
      const onSelect = vi.fn();
      render(
        <EntitySwitcher
          currentId={currentId}
          items={items}
          onSelect={onSelect}
          showCurrent
          {...LABELS}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: LABELS.triggerLabel }));
      return { onSelect };
    }

    it('lists the current one too, marked as current', () => {
      openShowingCurrent(two, 'item-1');
      expect(screen.getByRole('menuitem', { name: /Alpha/ })).toHaveAttribute(
        'aria-current',
        'true',
      );
      expect(screen.getByRole('menuitem', { name: /Beta/ })).not.toHaveAttribute(
        'aria-current',
      );
    });

    it('only closes when the current one is picked', () => {
      const { onSelect } = openShowingCurrent(two, 'item-1');
      fireEvent.click(screen.getByRole('menuitem', { name: /Alpha/ }));
      expect(onSelect).not.toHaveBeenCalled();
      expect(screen.queryByRole('menu')).toBeNull();
    });

    it('opens scrolled so the current row is centred in the list', () => {
      // jsdom has no layout, so give the list and the row the geometry a
      // browser would: a 100px-tall list whose current row sits 400px down.
      const offsetTop = vi
        .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
        .mockImplementation(function (this: HTMLElement) {
          return this.getAttribute('aria-current') === 'true' ? 400 : 0;
        });
      const offsetHeight = vi
        .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
        .mockReturnValue(20);
      const clientHeight = vi
        .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
        .mockReturnValue(100);
      try {
        openShowingCurrent(many(30), 'item-20');
        const list = screen.getByRole('menu').lastElementChild as HTMLElement;
        // 400 - (100 - 20) / 2
        expect(list.scrollTop).toBe(360);
      } finally {
        offsetTop.mockRestore();
        offsetHeight.mockRestore();
        clientHeight.mockRestore();
      }
    });
  });

  describe('grouped items', () => {
    /** Two sections, deliberately interleaved in the input array. */
    const grouped: EntitySwitcherItem[] = [
      { id: 'item-1', primary: 'Alpha', group: 'Spending' },
      { id: 'item-2', primary: 'Beta', group: 'Spending' },
      { id: 'item-3', primary: 'Gamma', group: 'Budget' },
    ];

    it('puts each row under its section heading', () => {
      open(grouped);
      const spending = screen.getByRole('group', { name: 'Spending' });
      const budget = screen.getByRole('group', { name: 'Budget' });
      // Alpha is the current entity, so Spending keeps only Beta.
      expect(within(spending).getByRole('menuitem', { name: /Beta/ })).toBeInTheDocument();
      expect(within(budget).getByRole('menuitem', { name: /Gamma/ })).toBeInTheDocument();
    });

    it('orders the sections by where each first appears, and reunites strays', () => {
      // Interleaved on purpose: Beta arrives after a Budget row, and still
      // belongs under the heading its section opened with.
      open(
        [
          { id: 'item-1', primary: 'Alpha', group: 'Spending' },
          { id: 'item-3', primary: 'Gamma', group: 'Budget' },
          { id: 'item-2', primary: 'Beta', group: 'Spending' },
        ],
        // Not one of them, so nothing is filtered out of the sections.
        'elsewhere',
      );
      const headings = screen
        .getAllByRole('group')
        .map((g) => g.getAttribute('aria-label'));
      expect(headings).toEqual(['Spending', 'Budget']);
      const spending = screen.getByRole('group', { name: 'Spending' });
      expect(
        within(spending)
          .getAllByRole('menuitem')
          .map((row) => row.textContent),
      ).toEqual(['Alpha', 'Beta']);
    });

    it('drops a section whose every row was filtered out', () => {
      // Long enough for the filter box; only the Budget row matches "gamma".
      open([...many(9), ...grouped], 'item-0');
      fireEvent.change(screen.getByPlaceholderText(LABELS.filterPlaceholder), {
        target: { value: 'gamma' },
      });
      expect(screen.getByRole('group', { name: 'Budget' })).toBeInTheDocument();
      // A heading with nothing under it reads as a section that lost its rows.
      expect(screen.queryByRole('group', { name: 'Spending' })).toBeNull();
    });

    it('leaves an ungrouped list free of headings', () => {
      open(two);
      expect(screen.queryAllByRole('group')).toEqual([]);
    });
  });

  it('closes on Escape and returns focus to the caret', () => {
    open(two);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: LABELS.triggerLabel })).toHaveFocus();
  });

  describe('placement', () => {
    /**
     * The caret sits at the end of a long account name in the Transactions
     * page's Account Info widget, and on a phone that is near the right edge.
     * An absolute `left-0 w-72` menu from there ran off the screen.
     */
    const caretNearRightEdge = { left: 300, top: 16, bottom: 40 };

    it('slides the menu left so it stays inside a narrow viewport', () => {
      const placed = placeMenu(caretNearRightEdge, 360, 800);
      expect(placed.width).toBe(MENU_WIDTH);
      expect(placed.left + placed.width).toBeLessThanOrEqual(360 - VIEWPORT_MARGIN);
      expect(placed.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      expect(placed.top).toBe(caretNearRightEdge.bottom + 4);
    });

    it('opens at the caret when there is room to its right', () => {
      const placed = placeMenu({ left: 40, top: 16, bottom: 40 }, 1280, 800);
      expect(placed.left).toBe(40);
      expect(placed.width).toBe(MENU_WIDTH);
    });

    it('shrinks the menu on a viewport narrower than the menu itself', () => {
      const placed = placeMenu(caretNearRightEdge, 240, 800);
      expect(placed.width).toBe(240 - 2 * VIEWPORT_MARGIN);
      expect(placed.left).toBe(VIEWPORT_MARGIN);
    });

    it('opens upward when the caret is near the bottom and the room is above', () => {
      const placed = placeMenu({ left: 40, top: 700, bottom: 724 }, 1280, 800);
      expect(placed.bottom).toBe(800 - 700 + 4);
      expect(placed.top).toBeUndefined();
      expect(placed.maxHeight).toBeLessThanOrEqual(700);
    });

    it('renders the menu in a portal, so a clipping or transformed ancestor cannot cut it off', () => {
      open(two);
      const menu = screen.getByRole('menu');
      expect(menu.parentElement).toBe(document.body);
      expect(menu.style.position).toBe('fixed');
    });

    it('positions the rendered menu from the caret, clamped to the viewport', () => {
      const originalWidth = window.innerWidth;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
      const rectSpy = vi
        .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
        .mockReturnValue({
          left: 300,
          right: 324,
          top: 16,
          bottom: 40,
          width: 24,
          height: 24,
          x: 300,
          y: 16,
          toJSON: () => ({}),
        } as DOMRect);
      try {
        open(two);
        const menu = screen.getByRole('menu');
        const left = parseFloat(menu.style.left);
        const width = parseFloat(menu.style.width);
        expect(left + width).toBeLessThanOrEqual(360 - VIEWPORT_MARGIN);
        expect(left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
      } finally {
        rectSpy.mockRestore();
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
      }
    });

    it('treats a click inside the portalled menu as inside, and one elsewhere as outside', () => {
      open(many(12));
      fireEvent.mouseDown(screen.getByPlaceholderText(LABELS.filterPlaceholder));
      expect(screen.getByRole('menu')).toBeInTheDocument();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('menu')).toBeNull();
    });

    /** Run the re-measure synchronously; jsdom has no frames to wait for. */
    function withImmediateFrames<T>(run: () => T): T {
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      vi.stubGlobal('cancelAnimationFrame', () => undefined);
      try {
        return run();
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it('focuses the filter without scrolling it into view, for a mouse', () => {
      const focus = vi.spyOn(HTMLInputElement.prototype, 'focus');
      try {
        open(many(12));
        expect(focus).toHaveBeenCalledWith({ preventScroll: true });
        expect(screen.getByPlaceholderText(LABELS.filterPlaceholder)).toHaveFocus();
      } finally {
        focus.mockRestore();
      }
    });

    it('leaves the filter unfocused on a touch device, so the keyboard stays down', () => {
      touch.current = true;
      try {
        open(many(12));
        const filter = screen.getByPlaceholderText(LABELS.filterPlaceholder);
        expect(filter).toBeInTheDocument();
        expect(filter).not.toHaveFocus();
        // Still there to be tapped.
        fireEvent.change(filter, { target: { value: 'number 7' } });
        expect(screen.getByRole('menuitem', { name: /Thing number 7/ })).toBeInTheDocument();
      } finally {
        touch.current = false;
      }
    });

    it('stays open and follows the caret when the page scrolls', async () => {
      // Opening focuses the filter, which scrolls its container into view; a
      // menu that closed on scroll flashed open and shut. It re-measures instead.
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
      const at = (top: number) =>
        ({ left: 40, right: 64, top, bottom: top + 24, width: 24, height: 24, x: 40, y: top, toJSON: () => ({}) }) as DOMRect;
      rectSpy.mockReturnValue(at(100));
      try {
        await withImmediateFrames(async () => {
          open(many(12));
          expect(screen.getByRole('menu').style.top).toBe(`${100 + 24 + 4}px`);
          rectSpy.mockReturnValue(at(60));
          await act(async () => {
            document.documentElement.dispatchEvent(new Event('scroll', { bubbles: false }));
          });
          expect(screen.getByRole('menu')).toBeInTheDocument();
          expect(screen.getByRole('menu').style.top).toBe(`${60 + 24 + 4}px`);
        });
      } finally {
        rectSpy.mockRestore();
      }
    });

    it('stays open when the viewport resizes, as it does when a phone keyboard appears', async () => {
      await withImmediateFrames(async () => {
        open(two);
        await act(async () => {
          window.dispatchEvent(new Event('resize'));
        });
        expect(screen.getByRole('menu')).toBeInTheDocument();
      });
    });

    it('does not re-measure for a scroll inside its own list', async () => {
      const rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect');
      rectSpy.mockReturnValue({ left: 40, right: 64, top: 100, bottom: 124, width: 24, height: 24, x: 40, y: 100, toJSON: () => ({}) } as DOMRect);
      try {
        await withImmediateFrames(async () => {
          open(many(12));
          const calls = rectSpy.mock.calls.length;
          const list = screen.getByRole('menu').querySelector('.overflow-y-auto') as HTMLElement;
          await act(async () => {
            list.dispatchEvent(new Event('scroll', { bubbles: false }));
          });
          expect(rectSpy.mock.calls.length).toBe(calls);
          expect(screen.getByRole('menu')).toBeInTheDocument();
        });
      } finally {
        rectSpy.mockRestore();
      }
    });
  });
});
