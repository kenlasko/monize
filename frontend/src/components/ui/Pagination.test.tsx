import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Pagination } from './Pagination';

describe('Pagination', () => {
  const defaultProps = {
    currentPage: 1,
    totalPages: 5,
    totalItems: 50,
    pageSize: 10,
    onPageChange: vi.fn(),
  };

  it('shows item range', () => {
    render(<Pagination {...defaultProps} />);
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
  });

  it('disables previous/first on first page', () => {
    render(<Pagination {...defaultProps} currentPage={1} />);
    expect(screen.getByTitle('First page')).toBeDisabled();
    expect(screen.getByTitle('Previous page')).toBeDisabled();
  });

  it('disables next/last on last page', () => {
    render(<Pagination {...defaultProps} currentPage={5} />);
    expect(screen.getByTitle('Last page')).toBeDisabled();
    expect(screen.getByTitle('Next page')).toBeDisabled();
  });

  it('calls onPageChange for next page', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByTitle('Next page'));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('calls onPageChange for last page', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByTitle('Last page'));
    expect(onPageChange).toHaveBeenCalledWith(5);
  });

  it('shows jump buttons when totalPages > 10', () => {
    render(<Pagination {...defaultProps} totalPages={20} totalItems={200} currentPage={10} />);
    expect(screen.getByTitle('Back 10 pages')).toBeInTheDocument();
    expect(screen.getByTitle('Forward 10 pages')).toBeInTheDocument();
  });

  it('does not show jump buttons when totalPages <= 10', () => {
    render(<Pagination {...defaultProps} />);
    expect(screen.queryByTitle('Back 10 pages')).not.toBeInTheDocument();
  });

  it('uses custom itemName', () => {
    render(<Pagination {...defaultProps} itemName="transactions" />);
    expect(screen.getByText(/transactions/)).toBeInTheDocument();
  });
});
