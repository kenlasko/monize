import { describe, it, expect } from 'vitest';
import { act, render, renderInLocale, screen } from '@/test/render';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { UserPreferences } from '@/types/auth';
import frBudgetMessages from '@/i18n/messages/fr/budgets.json';
import { BudgetProgressBar } from './BudgetProgressBar';

describe('BudgetProgressBar', () => {
  it('renders a progress bar with correct percentage', () => {
    render(<BudgetProgressBar percentUsed={60} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar).not.toHaveAttribute('aria-valuetext');
    expect(bar.style.width).toBe('60%');
  });

  it('uses the French percent pattern in the accessible name and value', () => {
    const previous = usePreferencesStore.getState().preferences;
    try {
      usePreferencesStore.setState({ preferences: { numberFormat: 'fr-FR' } as UserPreferences });
      renderInLocale(<BudgetProgressBar percentUsed={-12.5} />, {
        locale: 'fr', messages: { budgets: frBudgetMessages },
      });
      const value = new Intl.NumberFormat('fr-FR', { style: 'percent', maximumFractionDigits: 2 }).format(-0.125);
      const bar = screen.getByRole('progressbar');
      expect(bar.getAttribute('aria-label')).toBe(`${value} utilisé`);
      expect(bar.getAttribute('aria-valuetext')).toBe(value);
      expect(bar).toHaveAttribute('aria-valuenow', '0');
    } finally {
      act(() => usePreferencesStore.setState({ preferences: previous }));
    }
  });

  it.each([
    [30, 'ok'],
    [80, 'warn'],
    [95, 'high'],
    [110, 'over'],
  ])('names the level a UI style reads at %i%%', (percent, level) => {
    render(<BudgetProgressBar percentUsed={percent} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('data-level', level);
  });

  it('applies green color for low usage', () => {
    render(<BudgetProgressBar percentUsed={30} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('bg-green-500');
  });

  it('applies yellow color for moderate usage (75-89%)', () => {
    render(<BudgetProgressBar percentUsed={80} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('bg-yellow-500');
  });

  it('applies orange color for high usage (90-99%)', () => {
    render(<BudgetProgressBar percentUsed={95} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('bg-orange-500');
  });

  it('applies red color when over budget (100%+)', () => {
    render(<BudgetProgressBar percentUsed={110} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.className).toContain('bg-red-500');
  });

  it.each([
    [-50, 0, '-50%'],
    [-12.25, 0, '-12.25%'],
    [150.75, 100, '150.75%'],
  ])('exposes %s%% used with a bounded progress value', (percent, position, text) => {
    render(<BudgetProgressBar percentUsed={percent} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuemin', '0');
    expect(bar).toHaveAttribute('aria-valuemax', '100');
    expect(bar).toHaveAttribute('aria-valuenow', String(position));
    expect(bar).toHaveAttribute('aria-valuetext', text);
    expect(bar).toHaveAccessibleName(`${text} used`);
    expect(bar.style.width).toBe(`${position}%`);
  });

  it('clamps width to 100% maximum', () => {
    render(<BudgetProgressBar percentUsed={150} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.style.width).toBe('100%');
  });

  it('clamps width to 0% minimum', () => {
    render(<BudgetProgressBar percentUsed={-10} />);

    const bar = screen.getByRole('progressbar');
    expect(bar.style.width).toBe('0%');
  });

  it('does not show pace marker by default', () => {
    render(<BudgetProgressBar percentUsed={50} pacePercent={60} />);

    expect(screen.queryByTestId('pace-marker')).not.toBeInTheDocument();
  });

  it('shows pace marker when showPaceMarker is true', () => {
    render(
      <BudgetProgressBar percentUsed={50} pacePercent={60} showPaceMarker />,
    );

    const marker = screen.getByTestId('pace-marker');
    expect(marker).toBeInTheDocument();
    expect(marker.style.left).toBe('60%');
  });

  it('clamps pace marker position to 0-100 range', () => {
    render(
      <BudgetProgressBar percentUsed={50} pacePercent={150} showPaceMarker />,
    );

    const marker = screen.getByTestId('pace-marker');
    expect(marker.style.left).toBe('100%');
  });

  it('does not show pace marker when pacePercent is undefined', () => {
    render(<BudgetProgressBar percentUsed={50} showPaceMarker />);

    expect(screen.queryByTestId('pace-marker')).not.toBeInTheDocument();
  });
});
