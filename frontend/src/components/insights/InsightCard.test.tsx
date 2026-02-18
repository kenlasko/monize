import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InsightCard } from './InsightCard';
import type { AiInsight } from '@/types/ai';

function makeInsight(overrides: Partial<AiInsight> = {}): AiInsight {
  return {
    id: 'insight-1',
    type: 'anomaly',
    title: 'High spending on Dining',
    description: 'Your dining spending is 80% above average.',
    severity: 'warning',
    data: { categoryName: 'Dining', currentAmount: 450 },
    isDismissed: false,
    generatedAt: '2026-02-18T00:00:00.000Z',
    expiresAt: '2026-02-25T00:00:00.000Z',
    createdAt: '2026-02-18T00:00:00.000Z',
    ...overrides,
  };
}

describe('InsightCard', () => {
  it('renders insight title and description', () => {
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    expect(screen.getByText('High spending on Dining')).toBeInTheDocument();
    expect(
      screen.getByText('Your dining spending is 80% above average.'),
    ).toBeInTheDocument();
  });

  it('renders insight type badge', () => {
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    expect(screen.getByText('Anomaly')).toBeInTheDocument();
  });

  it('renders different type badges', () => {
    render(
      <InsightCard
        insight={makeInsight({ type: 'trend' })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    expect(screen.getByText('Trend')).toBeInTheDocument();
  });

  it('renders dismiss button for active insights', () => {
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    expect(screen.getByText('Dismiss')).toBeInTheDocument();
  });

  it('hides dismiss button for dismissed insights', () => {
    render(
      <InsightCard
        insight={makeInsight({ isDismissed: true })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    expect(screen.queryByText('Dismiss')).not.toBeInTheDocument();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={onDismiss}
        isDismissing={false}
      />,
    );

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledWith('insight-1');
  });

  it('shows dismissing state', () => {
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={vi.fn()}
        isDismissing={true}
      />,
    );

    expect(screen.getByText('Dismissing...')).toBeInTheDocument();
  });

  it('applies warning severity styles', () => {
    const { container } = render(
      <InsightCard
        insight={makeInsight({ severity: 'warning' })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-amber-200');
  });

  it('applies alert severity styles', () => {
    const { container } = render(
      <InsightCard
        insight={makeInsight({ severity: 'alert' })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-red-200');
  });

  it('applies info severity styles', () => {
    const { container } = render(
      <InsightCard
        insight={makeInsight({ severity: 'info' })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('border-blue-200');
  });

  it('renders generated date', () => {
    render(
      <InsightCard
        insight={makeInsight()}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    // Date format depends on locale, just check it renders something
    expect(
      screen.getByText((content) => content.includes('2026') || content.includes('2/18')),
    ).toBeInTheDocument();
  });

  it('applies opacity to dismissed insights', () => {
    const { container } = render(
      <InsightCard
        insight={makeInsight({ isDismissed: true })}
        onDismiss={vi.fn()}
        isDismissing={false}
      />,
    );

    const card = container.firstChild as HTMLElement;
    expect(card.className).toContain('opacity-50');
  });
});
