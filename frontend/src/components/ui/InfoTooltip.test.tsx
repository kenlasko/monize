import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@/test/render';
import { InfoTooltip } from './InfoTooltip';
import { Modal, __resetModalStateForTesting } from './Modal';
import { useHelpStore } from '@/store/helpStore';

const getManifest = vi.fn();
vi.mock('@/lib/help', () => ({ helpApi: { getManifest: () => getManifest() } }));

beforeEach(() => {
  getManifest.mockReset();
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('InfoTooltip', () => {
  it('renders tooltip text', () => {
    render(<InfoTooltip text="Help text here" />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text here');
  });

  it('exposes the text via aria-label without a native title', () => {
    render(<InfoTooltip text="Helpful info" />);
    const span = screen.getByLabelText('Helpful info');
    expect(span).toHaveAttribute('aria-label', 'Helpful info');
    expect(span).not.toHaveAttribute('title');
  });

  it('applies bottom placement classes by default', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('top-full');
  });

  it('applies top placement classes when placement is top', () => {
    render(<InfoTooltip text="Tooltip" placement="top" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('bottom-full');
  });

  it('anchors the popover to the right edge when align is right', () => {
    render(<InfoTooltip text="Tooltip" align="right" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('right-0');
    expect(tooltipEl.className).not.toContain('left-0');
  });

  it('keeps the default left anchor for bottom placement', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('left-0');
    expect(tooltipEl.className).not.toContain('right-0');
  });

  it('applies custom icon className', () => {
    const { container } = render(<InfoTooltip text="Tooltip" iconClassName="h-6 w-6" />);
    expect(container.querySelector('.h-6.w-6')).toBeInTheDocument();
  });

  it('is reachable by keyboard and reveals the popover on hover and keyboard focus', () => {
    render(<InfoTooltip text="Keyboard help" />);
    const trigger = screen.getByLabelText('Keyboard help');
    expect(trigger.tagName).toBe('BUTTON');
    const popover = screen.getByRole('tooltip');
    expect(popover.className).toContain('group-hover/tip:block');
    // focus-within, not a focus-visible restricted to the button itself: the
    // popover is a sibling of the trigger, not its child, so it needs the
    // ancestor the two share to notice focus landing on either one.
    expect(popover.className).toContain('group-focus-within/tip:block');
  });

  it('is a button, not a focusable span', () => {
    // A span's implicit role is generic: screen readers skip it and drop its
    // aria-label, so a tabIndex on one is a tab stop that announces nothing.
    // The trigger is announced as a button, and never submits its form.
    render(<InfoTooltip text="Named help" />);
    const trigger = screen.getByRole('button', { name: 'Named help' });
    expect(trigger).toHaveAttribute('type', 'button');
    expect(trigger).not.toHaveAttribute('tabindex');
  });

  it('dismisses the popover on Escape and re-arms on the next focus', () => {
    render(<InfoTooltip text="Escapable" />);
    const trigger = screen.getByRole('button', { name: 'Escapable' });

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.getByRole('tooltip').className).not.toContain(
      'group-focus-within/tip:block',
    );

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip').className).toContain(
      'group-focus-within/tip:block',
    );
  });

  it('opens and closes the portal popover on focus and blur', () => {
    render(<InfoTooltip text="Portal help" usePortal />);
    const trigger = screen.getByRole('button', { name: 'Portal help' });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Portal help');

    fireEvent.blur(trigger);
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('dismisses the portal popover on Escape', () => {
    render(<InfoTooltip text="Portal escape" usePortal />);
    const trigger = screen.getByRole('button', { name: 'Portal escape' });

    fireEvent.focus(trigger);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  describe('Escape only belongs to this component while a popover is up', () => {
    // The regression: `dismissOnEscape` stopped propagation unconditionally.
    // `Modal` closes on a document-level keydown listener, which a stopped
    // event never reaches, so with focus on any tooltip trigger inside any
    // modal the first Escape dismissed the tooltip and every Escape after it
    // was eaten too -- the modal could not be closed from the keyboard.
    const listeners: Array<(event: KeyboardEvent) => void> = [];

    function watchDocumentEscapes() {
      const seen = vi.fn();
      const listener = (event: KeyboardEvent) => {
        if (event.key === 'Escape') seen();
      };
      document.addEventListener('keydown', listener);
      listeners.push(listener);
      return seen;
    }

    afterEach(() => {
      listeners.splice(0).forEach((listener) => {
        document.removeEventListener('keydown', listener);
      });
      __resetModalStateForTesting();
    });

    it('lets Escape through when the portal popover is not showing', () => {
      const reachedDocument = watchDocumentEscapes();
      render(<InfoTooltip text="Quiet help" usePortal />);

      fireEvent.keyDown(screen.getByRole('button', { name: 'Quiet help' }), {
        key: 'Escape',
      });

      expect(reachedDocument).toHaveBeenCalledTimes(1);
    });

    it('claims the first Escape and releases every one after it', () => {
      const reachedDocument = watchDocumentEscapes();
      render(<InfoTooltip text="Portal help" usePortal />);
      const trigger = screen.getByRole('button', { name: 'Portal help' });

      fireEvent.focus(trigger);
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      expect(reachedDocument).not.toHaveBeenCalled();

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(reachedDocument).toHaveBeenCalledTimes(1);
    });

    it('releases Escape once the CSS popover has been dismissed', () => {
      const reachedDocument = watchDocumentEscapes();
      render(<InfoTooltip text="Inline help" />);
      const trigger = screen.getByRole('button', { name: 'Inline help' });

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(reachedDocument).not.toHaveBeenCalled();

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(reachedDocument).toHaveBeenCalledTimes(1);
    });

    it('leaves a surrounding Modal closable from the keyboard', () => {
      const onClose = vi.fn();
      render(
        <Modal isOpen onClose={onClose}>
          <InfoTooltip text="Modal help" />
        </Modal>,
      );
      const trigger = screen.getByRole('button', { name: 'Modal help' });

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('learnMore', () => {
    it('renders no link without learnMore', () => {
      render(<InfoTooltip text="Plain help" />);
      fireEvent.focus(screen.getByRole('button', { name: 'Plain help' }));
      expect(screen.queryByRole('link', { name: 'Learn more' })).not.toBeInTheDocument();
    });

    it('opens the panel at the target and closes the popover on click', () => {
      useHelpStore.getState().setGuideAvailable(true);
      render(<InfoTooltip text="What the rate means" learnMore="currencyHomeRate" />);
      const trigger = screen.getByRole('button', { name: 'What the rate means' });
      fireEvent.focus(trigger);

      const link = screen.getByRole('link', { name: 'Learn more' });
      expect(link).toHaveAttribute(
        'href',
        'https://www.monize.net/docs/currency-management#home-currency',
      );

      fireEvent.click(link);

      expect(useHelpStore.getState().open).toBe(true);
      expect(useHelpStore.getState().history).toEqual([
        { page: 'currency-management', section: 'home-currency' },
      ]);
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      // The inline (CSS-driven) popover stays in the DOM, just hidden.
      expect(screen.getByRole('tooltip').className.split(/\s+/)).toContain('hidden');
    });

    it('is reachable from the keyboard: Tab from the trigger, then Enter', () => {
      useHelpStore.getState().setGuideAvailable(true);
      render(<InfoTooltip text="Keyboard reachable" learnMore="budgets" />);
      const trigger = screen.getByRole('button', { name: 'Keyboard reachable' });

      fireEvent.focus(trigger);
      const link = screen.getByRole('link', { name: 'Learn more' });
      link.focus();
      expect(link).toHaveFocus();

      fireEvent.click(link);
      expect(useHelpStore.getState().open).toBe(true);
    });

    it('keeps the popover reachable while hovering across the gap to the link', () => {
      vi.useFakeTimers();
      try {
        render(<InfoTooltip text="Hover reachable" learnMore="budgets" usePortal />);
        const trigger = screen.getByRole('button', { name: 'Hover reachable' });

        fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
        const link = screen.getByRole('link', { name: 'Learn more' });

        // Leaving the trigger for the link crosses a gap outside the
        // button's box; the close is delayed so the link stays reachable.
        fireEvent.pointerLeave(trigger, { pointerType: 'mouse' });
        fireEvent.pointerEnter(link, { pointerType: 'mouse' });
        act(() => vi.advanceTimersByTime(150));
        expect(screen.getByRole('tooltip')).toBeInTheDocument();

        fireEvent.pointerLeave(link, { pointerType: 'mouse' });
        act(() => vi.advanceTimersByTime(150));
        expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
