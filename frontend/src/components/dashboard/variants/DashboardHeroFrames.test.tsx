import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { render } from '@/test/render';
import { DashboardHeroFrameClassic } from './DashboardHeroFrameClassic';
import { DashboardHeroFrameModern } from './DashboardHeroFrameModern';
import type { DashboardHeroFrameProps, HeroNextUp } from './dashboard-hero-view';

const nextUp: HeroNextUp = {
  id: 'bill-1',
  name: 'Hydro Bill',
  payee: 'Hydro One',
  manual: true,
  kind: 'bill',
  amount: -120,
  currencyCode: 'USD',
  when: 'tomorrow',
  dueDate: '2026-11-21',
};

const base: DashboardHeroFrameProps = {
  header: <h1>Good morning, Demo</h1>,
  headRef: () => {},
  headSize: { width: 300, height: 40 },
  cycleControls: null,
  track: <div data-testid="track" />,
  nextUp,
};

describe('DashboardHeroFrameClassic', () => {
  it('draws the greeting and the sets over a guilloche hidden from assistive technology', () => {
    const { container } = render(<DashboardHeroFrameClassic {...base} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Good morning, Demo' })).toBeInTheDocument();
    expect(screen.getByTestId('track')).toBeInTheDocument();
    const ornament = container.querySelector('ellipse')?.closest('svg');
    expect(ornament).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('ellipse')).toHaveLength(24);
    // The next occurrence belongs to the Modern frame only.
    expect(screen.queryByText('Hydro Bill')).not.toBeInTheDocument();
  });
});

describe('DashboardHeroFrameModern', () => {
  it('puts the sets in the inverted block beside the next occurrence, with the way to record it', () => {
    render(<DashboardHeroFrameModern {...base} />);
    expect(screen.getByTestId('track').closest('.ui-invert')).not.toBeNull();
    const card = screen.getByRole('region', { name: 'Next up, tomorrow' });
    expect(card).toHaveTextContent('Hydro Bill');
    expect(card).toHaveTextContent('Hydro One · paid by hand');
    expect(card).toHaveTextContent('$120.00');
    expect(screen.getByRole('link', { name: 'Record payment' })).toHaveAttribute(
      'href',
      '/bills?postBillId=bill-1',
    );
    expect(screen.getByRole('link', { name: 'All upcoming' })).toHaveAttribute('href', '/bills');
  });

  it('says an amount it cannot work out is unknown, and draws no card with nothing scheduled', () => {
    const { rerender } = render(<DashboardHeroFrameModern {...base} nextUp={{ ...nextUp, amount: null }} />);
    expect(screen.getByRole('region', { name: 'Next up, tomorrow' })).not.toHaveTextContent('$');
    rerender(<DashboardHeroFrameModern {...base} nextUp={null} />);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
