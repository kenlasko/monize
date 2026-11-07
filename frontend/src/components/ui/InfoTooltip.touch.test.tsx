import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InfoTooltip, placePopover } from './InfoTooltip';
import { useLongPress } from '@/hooks/useLongPress';
import { useHelpStore } from '@/store/helpStore';

const getManifest = vi.fn();
vi.mock('@/lib/help', () => ({ helpApi: { getManifest: () => getManifest() } }));

beforeEach(() => {
  getManifest.mockReset();
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

/**
 * Contextual help a desktop reader can see, a touch reader can open.
 *
 * The icon used to be `hidden md:inline-flex` because its popover opened only
 * on hover, so every explanation (TWR, MWR, CAGR, investment result, an
 * incomplete valuation...) was simply missing on a phone. These cases pin the
 * tap path, and that it shows the one `text` the desktop popover shows.
 */

const HELP = 'Time-weighted return: performance with deposits neutralised.';

function tap(element: Element) {
  fireEvent.pointerDown(element, { pointerType: 'touch' });
  fireEvent.click(element);
}

describe('InfoTooltip on a touch device', () => {
  it.each([false, true])(
    'renders a trigger at every width (usePortal=%s)',
    (usePortal) => {
      render(<InfoTooltip text={HELP} usePortal={usePortal} />);
      const trigger = screen.getByRole('button', { name: HELP });
      // No breakpoint may hide the trigger: a phone is below every one of them.
      const classes = trigger.className.split(/\s+/);
      expect(classes).not.toContain('hidden');
      expect(classes.some((c) => /^(sm|md|lg|xl):/.test(c) && c.endsWith('flex'))).toBe(false);
      expect(classes).toContain('inline-flex');
    },
  );

  it('gives the small icon a finger-sized hit area', () => {
    render(<InfoTooltip text={HELP} />);
    expect(screen.getByRole('button', { name: HELP }).className).toMatch(
      /before:-inset-\S+/,
    );
  });

  it.each([false, true])(
    'opens the same text on a tap and reports it expanded (usePortal=%s)',
    (usePortal) => {
      render(<InfoTooltip text={HELP} usePortal={usePortal} />);
      const trigger = screen.getByRole('button', { name: HELP });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');

      tap(trigger);

      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      // A tap opens the viewport-clamped portal whichever variant the call site
      // chose: the inline popover is placed for a desktop column.
      const shown = screen
        .getAllByRole('tooltip')
        .filter((el) => el.parentElement === document.body);
      expect(shown).toHaveLength(1);
      expect(shown[0]).toHaveTextContent(HELP);
      expect(shown[0].style.position).toBe('fixed');
      // One source of truth: the label a screen reader reads is the same text.
      expect(trigger).toHaveAttribute('aria-label', HELP);
    },
  );

  it('does not open from the mouseenter a phone emulates for a tap', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });

    fireEvent.pointerEnter(trigger, { pointerType: 'touch' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    // ...so the tap's own click opens it, rather than toggling it shut.
    tap(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent(HELP);
  });

  it('does not open from the focus a tap gives the button', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });

    fireEvent.pointerDown(trigger, { pointerType: 'touch' });
    fireEvent.focus(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });

  it('closes on a tap outside', () => {
    render(
      <div>
        <InfoTooltip text={HELP} />
        <p>Elsewhere</p>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: HELP });
    tap(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.pointerDown(screen.getByText('Elsewhere'), { pointerType: 'touch' });

    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.getAllByRole('tooltip').filter((el) => el.parentElement === document.body),
    ).toHaveLength(0);
  });

  it('stays open for a tap on the popover itself, and that tap closes it', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });
    tap(trigger);
    const popover = screen.getByRole('tooltip');
    // A pinned popover takes the tap instead of passing it to the row beneath.
    expect(popover.className).not.toContain('pointer-events-none');

    fireEvent.pointerDown(popover, { pointerType: 'touch' });
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    // The click reaches the trigger through the React tree, portal and all.
    fireEvent.click(popover);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a Learn More link that a tap can reach and activate', () => {
    useHelpStore.getState().setGuideAvailable(true);
    render(<InfoTooltip text={HELP} learnMore="budgets" />);
    const trigger = screen.getByRole('button', { name: HELP });
    tap(trigger);

    // A tap always shows the viewport-clamped portal (even on a call site
    // that did not ask for `usePortal`); the hidden inline popover keeps its
    // own copy of the link for the hover/keyboard path, so there are two.
    const links = screen.getAllByRole('link', { name: 'Learn more' });
    const portalLink = links.find((el) => el.closest('[role="tooltip"]')?.parentElement === document.body);
    expect(portalLink).toBeDefined();

    fireEvent.click(portalLink!);
    expect(useHelpStore.getState().open).toBe(true);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on a second tap of the icon', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });
    tap(trigger);
    tap(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('re-places a pinned popover when the page scrolls under it', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });
    const rect = vi.spyOn(trigger, 'getBoundingClientRect');
    rect.mockReturnValue({ top: 100, bottom: 116, left: 40 } as DOMRect);
    tap(trigger);
    const popover = screen.getByRole('tooltip');
    expect(popover.style.top).toBe('120px');

    rect.mockReturnValue({ top: 60, bottom: 76, left: 40 } as DOMRect);
    fireEvent.scroll(window);
    expect(popover.style.top).toBe('80px');
    expect(screen.getByRole('tooltip')).toBe(popover);
  });

  it('does not open the clickable row it sits in, nor arm its long press', () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onLongPress = vi.fn();
    function Row() {
      const { getRowHandlers } = useLongPress<string>({ onClick, onLongPress });
      return (
        <table>
          <tbody>
            <tr {...getRowHandlers('row')}>
              <td>
                TWR <InfoTooltip text={HELP} />
              </td>
            </tr>
          </tbody>
        </table>
      );
    }
    try {
      render(<Row />);
      const trigger = screen.getByRole('button', { name: HELP });
      fireEvent.touchStart(trigger, { touches: [{ clientX: 0, clientY: 0 }] });
      fireEvent.contextMenu(trigger);
      vi.advanceTimersByTime(1000);
      tap(trigger);
      fireEvent.touchEnd(trigger);

      expect(onClick).not.toHaveBeenCalled();
      expect(onLongPress).not.toHaveBeenCalled();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('InfoTooltip on a desktop', () => {
  it('shows the portal popover while a mouse hovers and hides it after', () => {
    render(<InfoTooltip text={HELP} usePortal />);
    const trigger = screen.getByRole('button', { name: HELP });

    fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    expect(screen.getByRole('tooltip')).toHaveTextContent(HELP);
    // Hover alone does not pin: the popover lets the pointer through.
    expect(screen.getByRole('tooltip').className).toContain('pointer-events-none');

    fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('pins the inline popover on a click so it outlasts the hover', () => {
    render(<InfoTooltip text={HELP} />);
    const trigger = screen.getByRole('button', { name: HELP });

    fireEvent.pointerDown(trigger, { pointerType: 'mouse' });
    fireEvent.click(trigger);

    const popover = screen.getByRole('tooltip');
    expect(popover.className.split(/\s+/)).toContain('block');
    expect(popover.className.split(/\s+/)).not.toContain('hidden');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('opens from the keyboard with Enter and closes with Escape', () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={(event) => event.key === 'Escape' && outer()}>
        <InfoTooltip text={HELP} usePortal />
      </div>,
    );
    const trigger = screen.getByRole('button', { name: HELP });

    // Keyboard focus alone shows it; Enter (a click with no pointer) pins it.
    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent(HELP);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(outer).not.toHaveBeenCalled();
  });

  it('closes a pinned popover when focus moves to another control', () => {
    render(
      <div>
        <InfoTooltip text={HELP} />
        <button type="button">Next</button>
      </div>,
    );
    const trigger = screen.getByRole('button', { name: HELP });
    fireEvent.focus(trigger);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    fireEvent.blur(trigger, { relatedTarget: screen.getByRole('button', { name: 'Next' }) });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a pinned popover when focus merely leaves for the page', () => {
    // A tap on empty page blurs to nothing; the outside press decides that.
    render(<InfoTooltip text={HELP} />);
    const trigger = screen.getByRole('button', { name: HELP });
    fireEvent.click(trigger);
    fireEvent.blur(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('placePopover', () => {
  const viewport = { width: 360, height: 640 };
  const size = { width: 256, height: 80 };

  afterEach(() => vi.restoreAllMocks());

  it('keeps the requested side when it fits', () => {
    expect(placePopover({ top: 300, bottom: 316, left: 20 }, size, 'bottom', viewport)).toEqual({
      top: 320,
      left: 20,
    });
    expect(placePopover({ top: 300, bottom: 316, left: 20 }, size, 'top', viewport)).toEqual({
      top: 216,
      left: 20,
    });
  });

  it('clamps a popover near the right edge inside a phone screen', () => {
    const { left } = placePopover({ top: 300, bottom: 316, left: 330 }, size, 'bottom', viewport);
    expect(left).toBe(360 - 256 - 8);
  });

  it('flips a top popover below an icon at the top of the screen', () => {
    expect(placePopover({ top: 20, bottom: 36, left: 20 }, size, 'top', viewport).top).toBe(40);
  });

  it('flips a bottom popover above an icon at the bottom of the screen', () => {
    expect(placePopover({ top: 600, bottom: 616, left: 20 }, size, 'bottom', viewport).top).toBe(
      516,
    );
  });

  it('never places the popover off either edge when neither side fits', () => {
    const tall = { width: 256, height: 700 };
    const { top, left } = placePopover({ top: 300, bottom: 316, left: 20 }, tall, 'top', viewport);
    expect(top).toBe(8);
    expect(left).toBe(20);
  });
});
