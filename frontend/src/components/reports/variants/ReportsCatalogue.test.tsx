import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import userEvent from '@testing-library/user-event';
import { ReportsCatalogueClassic } from './ReportsCatalogueClassic';
import { ReportsCatalogueModern } from './ReportsCatalogueModern';
import type { ReportsCatalogueViewProps } from './reports-catalogue-view';

const entry = (id: string, name: string, category: 'spending' | 'income', favourite = false) => ({
  report: { id, icon: <svg />, category, color: '' },
  name,
  description: `${name} description`,
  categoryLabel: category === 'spending' ? 'Spending' : 'Income',
  favourite,
  tourAnchor: {},
});

function props(over: Partial<ReportsCatalogueViewProps> = {}): ReportsCatalogueViewProps {
  return {
    entries: [
      entry('a', 'Spending by Category', 'spending', true),
      entry('b', 'Spending by Payee', 'spending'),
      entry('c', 'Income vs Expenses', 'income'),
    ],
    categories: ['spending', 'income'],
    groupBySection: true,
    categoryLabel: (c) => (c === 'spending' ? 'Spending' : 'Income'),
    onOpen: vi.fn(),
    onToggleFavourite: vi.fn(),
    ...over,
  };
}

describe('ReportsCatalogueClassic', () => {
  it('groups the reports under a heading per section, numbered', () => {
    render(<ReportsCatalogueClassic {...props()} />);
    expect(screen.getByRole('heading', { name: 'Spending' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Income' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('opens a report and toggles its favourite separately', async () => {
    const p = props();
    render(<ReportsCatalogueClassic {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /Spending by Payee/ }));
    expect(p.onOpen).toHaveBeenCalledWith('b');
    await userEvent.click(screen.getAllByRole('button', { name: 'Add to favourites' })[0]);
    expect(p.onToggleFavourite).toHaveBeenCalled();
  });

  it('shows one section when a single section is filtered', () => {
    render(<ReportsCatalogueClassic {...props({ groupBySection: false, entries: [entry('a', 'A', 'spending')] })} />);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });
});

describe('ReportsCatalogueModern', () => {
  it('puts the favourites in their own block and the rest below', () => {
    render(<ReportsCatalogueModern {...props()} />);
    expect(screen.getByRole('heading', { name: 'Favourites' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Remove from favourites' })).toBeInTheDocument();
  });

  it('draws no favourites block when there are none', () => {
    render(<ReportsCatalogueModern {...props({ entries: [entry('b', 'B', 'spending')] })} />);
    expect(screen.queryByRole('heading', { name: 'Favourites' })).not.toBeInTheDocument();
  });

  it('opens a report from its tile', async () => {
    const p = props();
    render(<ReportsCatalogueModern {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /Income vs Expenses/ }));
    expect(p.onOpen).toHaveBeenCalledWith('c');
  });
});
