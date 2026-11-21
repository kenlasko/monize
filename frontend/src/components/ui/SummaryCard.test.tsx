import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SummaryCard, SummaryIcons } from './SummaryCard';

describe('SummaryCard', () => {
  it('renders label and value', () => {
    render(<SummaryCard label="Total" value="$1,000" icon={SummaryIcons.money} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
  });

  it('carries the stat markers a UI style sets the row by', () => {
    const { container } = render(
      <SummaryCard label="Net worth" value="$1,000" icon={SummaryIcons.money} hint="Partial" />
    );
    const tile = container.firstElementChild;
    expect(tile).toHaveClass('ui-stat');
    expect(tile).not.toHaveClass('ui-stat-lead');
    expect(screen.getByText('Net worth')).toHaveClass('ui-stat-label');
    expect(screen.getByText('$1,000')).toHaveClass('ui-stat-value');
    expect(screen.getByText('Partial')).toHaveClass('ui-stat-hint');
  });

  it('marks the lead figure of a row', () => {
    const { container } = render(
      <SummaryCard label="Net worth" value="$1,000" icon={SummaryIcons.money} lead />
    );
    expect(container.firstElementChild).toHaveClass('ui-stat', 'ui-stat-lead');
  });

  it('renders as div when no onClick', () => {
    const { container } = render(
      <SummaryCard label="Total" value="5" icon={SummaryIcons.accounts} />
    );
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders as button when onClick provided', () => {
    const onClick = vi.fn();
    render(<SummaryCard label="Total" value="5" icon={SummaryIcons.accounts} onClick={onClick} />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalled();
  });

  it('applies green valueColor class', () => {
    const { container } = render(
      <SummaryCard label="Income" value="$500" icon={<span />} valueColor="green" />
    );
    expect(container.querySelector('.text-green-600')).toBeInTheDocument();
  });

  it('applies red valueColor class', () => {
    const { container } = render(
      <SummaryCard label="Expenses" value="$300" icon={<span />} valueColor="red" />
    );
    expect(container.querySelector('.text-red-600')).toBeInTheDocument();
  });

  it('applies blue valueColor class', () => {
    const { container } = render(
      <SummaryCard label="Balance" value="$1000" icon={<span />} valueColor="blue" />
    );
    expect(container.querySelector('.text-blue-600')).toBeInTheDocument();
  });

  it('applies yellow valueColor class', () => {
    const { container } = render(
      <SummaryCard label="Warning" value="Low" icon={<span />} valueColor="yellow" />
    );
    expect(container.querySelector('.text-yellow-600')).toBeInTheDocument();
  });
});

describe('SummaryIcons', () => {
  it('has expected icon keys', () => {
    expect(SummaryIcons.accounts).toBeDefined();
    expect(SummaryIcons.money).toBeDefined();
    expect(SummaryIcons.checkmark).toBeDefined();
    expect(SummaryIcons.cross).toBeDefined();
    expect(SummaryIcons.tag).toBeDefined();
  });
});
