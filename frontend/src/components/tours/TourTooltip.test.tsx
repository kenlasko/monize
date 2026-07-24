import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@/test/render';
import { TourTooltip, type TourTooltipLabels } from './TourTooltip';

const LABELS: TourTooltipLabels = {
  next: 'Next',
  back: 'Back',
  done: 'Done',
  endTour: 'End tour',
  tryIt: 'Try it',
  skipStep: 'Skip this step',
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
  render(
    <TourTooltip
      rect={RECT}
      title="Step title"
      body="Step body"
      stepLabel="2 of 5"
      interactive={false}
      isLast={false}
      canBack
      reducedMotion={false}
      leaveFocusToForm={false}
      labels={LABELS}
      {...handlers}
      {...props}
    />,
  );
  return handlers;
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

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

describe('TourTooltip', () => {
  it('renders title, body, and step counter', () => {
    setup();
    expect(screen.getByText('Step title')).toBeInTheDocument();
    expect(screen.getByText('Step body')).toBeInTheDocument();
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
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
    // Give the focus rAF a chance to (not) run.
    await new Promise((r) => setTimeout(r, 30));
    expect(document.activeElement).toBe(input);
  });
});
