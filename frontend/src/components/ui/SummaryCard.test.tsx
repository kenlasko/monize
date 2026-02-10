import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SummaryCard, SummaryIcons } from './SummaryCard';

describe('SummaryCard', () => {
  it('renders label and value', () => {
    render(<SummaryCard label="Total" value="$1,000" icon={SummaryIcons.money} />);
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.getByText('$1,000')).toBeInTheDocument();
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
