import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { MonthlyTaggedBalanceSummary } from './MonthlyTaggedBalanceSummary';
import type { FundingReportControls } from '@/hooks/useFundingReportControls';
import type { TaggedFunding } from '@/hooks/useTaggedFunding';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return { useNumberFormat: () => numberFormatMockDefaults() };
});

vi.mock('@/hooks/useDateFormat', () => ({
  useDateFormat: () => ({ formatMonth: (m: string) => m }),
}));

const controls = (status: TaggedFunding['status']): FundingReportControls =>
  ({
    scope: {},
    filter: { include: true, tagKey: 'scope', tagValue: 'household' },
    funding: { status, response: null, window: null, reload: vi.fn() },
  }) as unknown as FundingReportControls;

describe('MonthlyTaggedBalanceSummary', () => {
  // Issue #2413: with only the column in progress in the window the page asks
  // for nothing, so the funding fetch is off and never resolves; a skeleton
  // there would load forever.
  it('renders nothing while the funding view is on but the page asks for no window', () => {
    render(<MonthlyTaggedBalanceSummary controls={controls('off')} months={[]} />);
    expect(screen.queryByTestId('monthly-tagged-balance')).not.toBeInTheDocument();
  });

  it('shows the loading placeholder while the window is being fetched', () => {
    render(<MonthlyTaggedBalanceSummary controls={controls('loading')} months={['2025-01']} />);
    expect(screen.getByTestId('monthly-tagged-balance')).toBeInTheDocument();
  });
});
