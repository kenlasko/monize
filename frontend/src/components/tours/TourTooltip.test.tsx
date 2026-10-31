import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@/test/render';
import { TourTooltip, type TourTooltipLabels } from './TourTooltip';

const LABELS: TourTooltipLabels = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  endTour: 'End tour',
  tryIt: 'Try it',
  skipStep: 'Skip this step',
  move: 'Move this card',
};

const RECT = { top: 100, left: 100, width: 120, height: 40 };

function setup(props: Partial<React.ComponentProps<typeof TourTooltip>> = {}) {
  const handlers = {
    onNext: vi.fn(),
    onDone: vi.fn(),
    onBack: vi.fn(),
    onSkip: vi.fn(),
    onEnd: vi.fn(),
  };
  const baseProps: React.ComponentProps<typeof TourTooltip> = {
    rect: RECT,
    title: 'Step title',
    body: 'Step body',
    stepLabel: '2 of 5',
    interactive: false,
    isLast: false,
    canBack: true,
    reducedMotion: false,
    leaveFocusToForm: false,
    labels: LABELS,
    ...handlers,
    ...props,
  };
  const view = render(<TourTooltip {...baseProps} />);
  /** Re-render as the next step would, keeping the props under test. */
  const rerender = (next: Partial<React.ComponentProps<typeof TourTooltip>>) =>
    view.rerender(<TourTooltip {...baseProps} {...next} />);
  return { ...handlers, rerender };
}

beforeEach(() => {
  // Force the desktop (anchored) layout.
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
});

/** jsdom's default viewport, restored after the cases that resize it. */
const VIEWPORT = { width: window.innerWidth, height: window.innerHeight };

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  window.innerWidth = VIEWPORT.width;
  window.innerHeight = VIEWPORT.height;
});

describe('TourTooltip', () => {
  it('flips the phone sheet away from a low anchor, then returns below a high one', async () => {
    window.innerWidth = 390;
    window.innerHeight = 844;
    vi.mocked(window.matchMedia).mockReturnValue({
      ...window.matchMedia('(max-width: 639px)'),
      matches: true,
    });
    const height = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockReturnValue(200);
    try {
      const { rerender } = setup({
        rect: { top: 530, left: 16, width: 358, height: 280 },
        interactive: true,
      });
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveClass('top-0'));
      expect(screen.getByRole('dialog')).not.toHaveClass('bottom-0');

      rerender({ rect: RECT, stepLabel: '3 of 5' });
      await waitFor(() => expect(screen.getByRole('dialog')).toHaveClass('bottom-0'));
      expect(screen.getByRole('dialog')).not.toHaveClass('top-0');

      rerender({ rect: null, stepLabel: '4 of 5' });
      expect(screen.getByRole('dialog')).toHaveClass('bottom-0');
    } finally {
      height.mockRestore();
    }
  });

  it('renders title, body, and step counter', () => {
    setup();
    expect(screen.getByText('Step title')).toBeInTheDocument();
    expect(screen.getByText('Step body')).toBeInTheDocument();
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
  });

  describe('repositioning', () => {
    const handle = () => screen.getByLabelText('Move this card');
    const cardPos = () => {
      const card = screen.getByRole('dialog') as HTMLElement;
      return { top: card.style.top, left: card.style.left };
    };

    it('moves the card when the handle is dragged', () => {
      setup();
      const before = cardPos();

      fireEvent.pointerDown(handle(), { clientX: 500, clientY: 400, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientX: 560, clientY: 450, pointerId: 1 });
      fireEvent.pointerUp(handle(), { pointerId: 1 });

      const after = cardPos();
      expect(after).not.toEqual(before);
      expect(parseFloat(after.left)).toBe(parseFloat(before.left) + 60);
      expect(parseFloat(after.top)).toBe(parseFloat(before.top) + 50);
    });

    it('ignores pointer movement that did not start on the handle', () => {
      setup();
      const before = cardPos();
      fireEvent.pointerMove(handle(), { clientX: 900, clientY: 700, pointerId: 1 });
      expect(cardPos()).toEqual(before);
    });

    it('nudges the card with the arrow keys for keyboard users', () => {
      setup();
      const before = cardPos();

      fireEvent.keyDown(handle(), { key: 'ArrowRight' });
      expect(parseFloat(cardPos().left)).toBe(parseFloat(before.left) + 24);

      fireEvent.keyDown(handle(), { key: 'ArrowUp' });
      expect(parseFloat(cardPos().top)).toBe(parseFloat(before.top) - 24);
    });

    it('keeps the card inside the viewport', () => {
      setup();
      // Drag far past the bottom-right corner.
      fireEvent.pointerDown(handle(), { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle(), { clientX: 99999, clientY: 99999, pointerId: 1 });
      fireEvent.pointerUp(handle(), { pointerId: 1 });

      const { top, left } = cardPos();
      expect(parseFloat(top)).toBeLessThanOrEqual(window.innerHeight);
      expect(parseFloat(left)).toBeLessThanOrEqual(window.innerWidth);
    });

    it('returns to the automatic position on the next step', () => {
      const { rerender } = setup();
      fireEvent.keyDown(handle(), { key: 'ArrowRight' });
      const moved = cardPos();

      // Same anchor, next step: the manual position does not carry over.
      rerender({ stepLabel: '3 of 5', title: 'Next step title' });
      expect(parseFloat(cardPos().left)).toBe(parseFloat(moved.left) - 24);
    });

    it('hides the card until it has been measured for the new step', async () => {
      const card = () => screen.getByRole('dialog') as HTMLElement;
      const { rerender } = setup();
      await waitFor(() => expect(card().className).toContain('opacity-100'));

      // A new step means a new card size, so the old measurement is dropped
      // and the card stays invisible until it is measured again -- otherwise it
      // paints at a position derived from the previous step's dimensions and
      // visibly jumps.
      rerender({ stepLabel: '3 of 5', title: 'Another step' });
      expect(card().className).toContain('opacity-0');
      await waitFor(() => expect(card().className).toContain('opacity-100'));
    });

    it('pulls a dragged card back inside a shrunken viewport', () => {
      setup();
      fireEvent.pointerDown(handle(), { clientX: 0, clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle(), {
        clientX: 900,
        clientY: 700,
        pointerId: 1,
      });
      fireEvent.pointerUp(handle(), { pointerId: 1 });
      const parked = cardPos();

      window.innerWidth = 500;
      window.innerHeight = 400;
      fireEvent(window, new Event('resize'));

      // The manual position survives the step, but not at coordinates that put
      // the card (and its drag handle) outside the window.
      const after = cardPos();
      expect(parseFloat(after.left)).toBeLessThan(parseFloat(parked.left));
      expect(parseFloat(after.left)).toBeLessThanOrEqual(500);
      expect(parseFloat(after.top)).toBeLessThanOrEqual(400);
    });

    it('parks a coach mark clear of right-aligned row actions on request', () => {
      // The default corner is the right one, which is where every list puts its
      // row actions -- so a step asking the user to click one had its own card
      // intercepting the click. `placement: 'left'` is how such a step opts out.
      setup({ rect: null, corner: true });
      const right = parseFloat(cardPos().left);

      cleanup();
      setup({ rect: null, corner: true, placement: 'left' });
      const left = parseFloat(cardPos().left);

      expect(left).toBe(16);
      expect(left).toBeLessThan(right);
    });

    it('ignores that opt-out for an anchored card, which has an anchor to sit against', () => {
      // 'left' means "left of the anchor" there, and `computeTooltipPosition`
      // already owns that decision.
      setup({ rect: RECT, corner: true, placement: 'left' });
      expect(parseFloat(cardPos().left)).not.toBe(16);
    });

    it('keeps a corner-parked card against the resized viewport', () => {
      setup({ rect: null, corner: true });
      const before = cardPos();

      window.innerWidth = 800;
      window.innerHeight = 600;
      fireEvent(window, new Event('resize'));

      const after = cardPos();
      expect(after).not.toEqual(before);
      expect(parseFloat(after.left)).toBeLessThan(800);
      expect(parseFloat(after.top)).toBeLessThan(600);
    });
  });

  it('emphasizes **bold** segments in the body', () => {
    setup({ body: 'Choose **Edit** from the menu' });
    const strong = screen.getByText('Edit');
    expect(strong.tagName).toBe('STRONG');
    // The ** markers are consumed, not shown literally.
    expect(screen.queryByText(/\*\*/)).toBeNull();
    expect(screen.getByText(/Choose/)).toBeInTheDocument();
    expect(screen.getByText(/from the menu/)).toBeInTheDocument();
  });

  it('shows Next on a passive non-final step and calls onNext', () => {
    const h = setup();
    fireEvent.click(screen.getByText('Next'));
    expect(h.onNext).toHaveBeenCalled();
  });

  it('shows Done on the final step and calls onDone', () => {
    const h = setup({ isLast: true });
    fireEvent.click(screen.getByText('Done'));
    expect(h.onDone).toHaveBeenCalled();
    expect(screen.queryByText('Next')).toBeNull();
  });

  it('shows the Try it hint and Skip link on interactive steps (no Next)', () => {
    const h = setup({ interactive: true });
    expect(screen.getByText('Try it')).toBeInTheDocument();
    expect(screen.queryByText('Next')).toBeNull();
    fireEvent.click(screen.getByText('Skip this step'));
    expect(h.onSkip).toHaveBeenCalled();
  });

  it('hides Back on the first step', () => {
    setup({ canBack: false });
    expect(screen.queryByText('Back')).toBeNull();
  });

  it('End tour triggers onEnd', () => {
    const h = setup();
    fireEvent.click(screen.getByText('End tour'));
    expect(h.onEnd).toHaveBeenCalled();
  });

  it('moves focus to the card on a passive step', async () => {
    setup();
    await waitFor(() => {
      const dialog = document.body.querySelector('[role="dialog"]');
      expect(document.activeElement).toBe(dialog);
    });
  });

  it('leaves focus with the form for in-form steps', async () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    setup({ leaveFocusToForm: true });
    // Give the focus rAF a chance to (not) run. Inside act, because the
    // measuring rAF beside it *does* run and sets the card's size.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.activeElement).toBe(input);
  });
});
