import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { SuggestedQueries } from './SuggestedQueries';

describe('SuggestedQueries', () => {
  it('renders the heading and description', () => {
    render(<SuggestedQueries onSelect={vi.fn()} />);

    expect(screen.getByText('Ask about your finances')).toBeInTheDocument();
    expect(
      screen.getByText(/I can answer questions about your spending/),
    ).toBeInTheDocument();
  });

  it('renders all 6 suggestion cards', () => {
    render(<SuggestedQueries onSelect={vi.fn()} />);

    expect(screen.getByText('Monthly spending')).toBeInTheDocument();
    expect(screen.getByText('Top categories')).toBeInTheDocument();
    expect(screen.getByText('Account balances')).toBeInTheDocument();
    expect(screen.getByText('Compare months')).toBeInTheDocument();
    expect(screen.getByText('Net worth trend')).toBeInTheDocument();
    expect(screen.getByText('Savings rate')).toBeInTheDocument();
  });

  it('shows the full query text for each suggestion', () => {
    render(<SuggestedQueries onSelect={vi.fn()} />);

    expect(
      screen.getByText('How much did I spend last month?'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('What are my current account balances?'),
    ).toBeInTheDocument();
  });

  it('calls onSelect with the query text when a suggestion is clicked', () => {
    const onSelect = vi.fn();
    render(<SuggestedQueries onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Monthly spending'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('How much did I spend last month?');
  });

  it('calls onSelect with different queries for different suggestions', () => {
    const onSelect = vi.fn();
    render(<SuggestedQueries onSelect={onSelect} />);

    fireEvent.click(screen.getByText('Account balances'));

    expect(onSelect).toHaveBeenCalledWith(
      'What are my current account balances?',
    );
  });

  it('renders suggestion buttons that are clickable', () => {
    render(<SuggestedQueries onSelect={vi.fn()} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBe(6);
  });
});
