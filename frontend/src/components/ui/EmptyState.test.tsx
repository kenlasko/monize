import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { EmptyState } from './EmptyState';
import { useHelpStore } from '@/store/helpStore';
import type { UiStyle } from '@/lib/ui-styles';

const style = vi.hoisted(() => ({ current: 'standard' as UiStyle }));
vi.mock('@/hooks/useUiStyle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useUiStyle')>()),
  useUiStyle: () => style.current,
}));

beforeEach(() => {
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  style.current = 'standard';
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

describe.each(['folio', 'pebble'] as const)('EmptyState in the %s style', (uiStyle) => {
  beforeEach(() => {
    style.current = uiStyle;
  });

  it('says the same things: title, description, help and action', () => {
    render(
      <EmptyState
        icon={<svg data-testid="glyph" />}
        title="Nothing in this register yet"
        description="Enter the first transaction by hand."
        help="budgets"
        action={<button>New transaction</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Nothing in this register yet' })).toBeInTheDocument();
    expect(screen.getByText('Enter the first transaction by hand.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'How this works' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New transaction' })).toBeInTheDocument();
  });
});

describe('EmptyState in the Folio style', () => {
  beforeEach(() => {
    style.current = 'folio';
  });

  it('sets the page flush left with the rosette in place of the glyph, hidden from assistive tech', () => {
    const { container } = render(
      <EmptyState icon={<svg data-testid="glyph" />} title="Nothing here" />,
    );
    const root = container.firstElementChild;
    expect(root).toHaveClass('ui-empty', 'ui-empty-folio', 'text-left');
    expect(screen.queryByTestId('glyph')).not.toBeInTheDocument();
    const ornament = container.querySelector('.ui-empty-ornament');
    expect(ornament).toBeTruthy();
    expect(ornament?.closest('[aria-hidden="true"]')).toBeTruthy();
  });

  it('keeps a caller class', () => {
    const { container } = render(<EmptyState title="Nothing here" className="py-6" />);
    expect(container.firstElementChild).toHaveClass('py-6');
    expect(container.firstElementChild).not.toHaveClass('py-10');
  });
});

describe('EmptyState in the Pebble style', () => {
  it('keeps the Standard arrangement, which the kit sheet re-skins', () => {
    style.current = 'pebble';
    const { container } = render(
      <EmptyState icon={<svg data-testid="glyph" />} title="Nothing here" />,
    );
    expect(container.firstElementChild).toHaveClass('ui-empty', 'text-center');
    expect(screen.getByTestId('glyph').closest('.ui-empty-icon')).toBeTruthy();
  });
});
