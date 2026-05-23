import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/render';
import { fireEvent, screen } from '@testing-library/react';
import { NewTransactionButton } from './NewTransactionButton';

describe('NewTransactionButton', () => {
  it('renders the New Transaction trigger', () => {
    render(<NewTransactionButton onNewInvestment={vi.fn()} onNewCash={vi.fn()} />);
    expect(screen.getByText('+ New Transaction')).toBeInTheDocument();
  });

  it('shows both options when clicked', () => {
    render(<NewTransactionButton onNewInvestment={vi.fn()} onNewCash={vi.fn()} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    expect(screen.getByText('Investment Transaction')).toBeInTheDocument();
    expect(screen.getByText('Cash Transaction')).toBeInTheDocument();
  });

  it('calls onNewInvestment when Investment Transaction is clicked', () => {
    const onNewInvestment = vi.fn();
    render(<NewTransactionButton onNewInvestment={onNewInvestment} onNewCash={vi.fn()} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    fireEvent.click(screen.getByText('Investment Transaction'));
    expect(onNewInvestment).toHaveBeenCalledOnce();
  });

  it('calls onNewCash when Cash Transaction is clicked', () => {
    const onNewCash = vi.fn();
    render(<NewTransactionButton onNewInvestment={vi.fn()} onNewCash={onNewCash} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    fireEvent.click(screen.getByText('Cash Transaction'));
    expect(onNewCash).toHaveBeenCalledOnce();
  });

  it('closes the menu after selecting an option', () => {
    render(<NewTransactionButton onNewInvestment={vi.fn()} onNewCash={vi.fn()} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    expect(screen.getByText('Cash Transaction')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Cash Transaction'));
    expect(screen.queryByText('Cash Transaction')).not.toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    render(<NewTransactionButton onNewInvestment={vi.fn()} onNewCash={vi.fn()} />);
    fireEvent.click(screen.getByText('+ New Transaction'));
    expect(screen.getByText('Investment Transaction')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('Investment Transaction')).not.toBeInTheDocument();
  });

  it('closes the menu when clicking outside', () => {
    render(
      <div>
        <NewTransactionButton onNewInvestment={vi.fn()} onNewCash={vi.fn()} />
        <span data-testid="outside">outside</span>
      </div>
    );
    fireEvent.click(screen.getByText('+ New Transaction'));
    expect(screen.getByText('Investment Transaction')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByText('Investment Transaction')).not.toBeInTheDocument();
  });
});
