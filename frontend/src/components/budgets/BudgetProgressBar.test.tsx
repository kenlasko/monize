import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { BudgetProgressBar } from './BudgetProgressBar';

describe('BudgetProgressBar', () => {
  it('renders a progress bar with correct percentage', () => {
    render(<BudgetProgressBar percentUsed={60} />);

    const bar = screen.getByRole('progressbar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute('aria-valuenow', '60');
    expect(bar.style.width).toBe('60%');
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
