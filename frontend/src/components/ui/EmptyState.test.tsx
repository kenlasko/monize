import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@/test/render';
import { EmptyState } from './EmptyState';
import { useHelpStore } from '@/store/helpStore';

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('EmptyState', () => {
  it('renders title, description and action', () => {
    render(
      <EmptyState
        title="No transactions"
        description="Add your first transaction to get started."
        action={<button>New Transaction</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'No transactions' })).toBeInTheDocument();
    expect(screen.getByText('Add your first transaction to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New Transaction' })).toBeInTheDocument();
  });

  it('renders the glyph as decoration when given', () => {
    const { container } = render(
      <EmptyState icon={<svg data-testid="glyph" />} title="Empty" />,
    );
    const holder = container.querySelector('[aria-hidden]');
    expect(holder).toBeTruthy();
    expect(holder?.querySelector('svg')).toBeTruthy();
  });

  it('renders no glyph holder without an icon', () => {
    const { container } = render(<EmptyState title="Empty" />);
    expect(container.querySelector('[aria-hidden]')).toBeNull();
  });

  it('renders no "How this works" link without help', () => {
    render(<EmptyState title="Empty" />);
    expect(screen.queryByRole('link', { name: 'How this works' })).not.toBeInTheDocument();
  });

  it('renders a "How this works" link beside the action when help is given', () => {
    render(
      <EmptyState
        title="No budgets"
        help="budgets"
        action={<button>New Budget</button>}
      />,
    );
    const link = screen.getByRole('link', { name: 'How this works' });
    expect(link).toHaveAttribute('href', 'https://www.monize.net/docs/budgets');
    expect(screen.getByRole('button', { name: 'New Budget' })).toBeInTheDocument();
  });
});
