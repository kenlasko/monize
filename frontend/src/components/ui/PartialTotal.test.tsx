import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@/test/render';
import { PartialTotal } from './PartialTotal';

describe('PartialTotal', () => {
  it('renders the figure alone when nothing was excluded', () => {
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: [], excludedCount: 0 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('$100.00')).toBeInTheDocument();
    expect(screen.queryByText('(partial total)')).not.toBeInTheDocument();
  });

  it('marks the figure and names the missing currencies', () => {
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: ['GBP'], excludedCount: 1 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('(partial total)')).toBeInTheDocument();
    // The tooltip is exposed via the trigger button's aria-label.
    const explanation = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(explanation).toContain('GBP');
    expect(explanation).toContain('No rate');
  });

  it('marks a figure short by an unpriced component that carries no currency', () => {
    // An unpriced holding bumps excludedCount without a missing currency. Keying
    // the marker off missingCurrencies alone rendered this as a complete total.
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: [], excludedCount: 2 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );
    expect(screen.getByText('(partial total)')).toBeInTheDocument();
    const explanation = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(explanation).toContain('could not be worked out');
    expect(explanation).not.toContain('No rate');
  });

  // A money figure sits inside cards that clip their overflow -- the report's
  // group headers carry `overflow-hidden` -- and at the right edge of narrow
  // columns. The CSS popover is absolutely positioned and a fixed 16rem wide,
  // so in both it is cut off, and an explanation the reader cannot finish is
  // the one thing the marker exists to give them.
  it('shows its explanation through the portal, so no card can clip it', async () => {
    render(
      <PartialTotal
        total={{ value: 100, missingCurrencies: ['GBP'], excludedCount: 1 }}
        displayCurrency="USD"
      >
        $100.00
      </PartialTotal>,
    );

    const trigger = screen.getByRole('button');
    await act(async () => {
      // Hover is a mouse's pointerenter: a phone emulates mouseenter on a tap.
      fireEvent.pointerEnter(trigger, { pointerType: 'mouse' });
    });

    const popover = screen.getByRole('tooltip');
    expect(popover).toBeInTheDocument();
    // Rendered on document.body, outside the figure's own subtree -- which is
    // what the CSS variant cannot do.
    expect(trigger.contains(popover)).toBe(false);
    expect(popover.textContent).toContain('GBP');
  });

  describe('provisionalCount', () => {
    it('adds the estimated-amounts mark to a complete figure at a count of 1', () => {
      render(
        <PartialTotal
          total={{ value: 100, missingCurrencies: [], excludedCount: 0 }}
          displayCurrency="USD"
          provisionalCount={1}
        >
          $100.00
        </PartialTotal>,
      );
      expect(screen.getByText('$100.00')).toBeInTheDocument();
      expect(screen.getByTestId('provisional-mark')).toBeInTheDocument();
      expect(screen.queryByTestId('partial-total-marker')).not.toBeInTheDocument();
    });

    it.each([[0], [undefined]])('adds nothing at a count of %s', (provisionalCount) => {
      render(
        <PartialTotal
          total={{ value: 100, missingCurrencies: [], excludedCount: 0 }}
          displayCurrency="USD"
          provisionalCount={provisionalCount}
        >
          $100.00
        </PartialTotal>,
      );
      expect(screen.queryByTestId('provisional-mark')).not.toBeInTheDocument();
    });

    it('shows both marks on a figure that is partial and provisional', () => {
      render(
        <PartialTotal
          total={{ value: 100, missingCurrencies: ['GBP'], excludedCount: 1 }}
          displayCurrency="USD"
          provisionalCount={1}
        >
          $100.00
        </PartialTotal>,
      );
      expect(screen.getByTestId('partial-total-marker')).toBeInTheDocument();
      expect(screen.getByTestId('provisional-mark')).toBeInTheDocument();
      const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? '');
      expect(labels.some((l) => l.includes('GBP'))).toBe(true);
      expect(labels.some((l) => l.includes('is:provisional'))).toBe(true);
    });
  });
});
