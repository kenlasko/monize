import { describe, it, expect, vi, beforeEach } from 'vitest';
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('handles page input change', () => {
    render(<Pagination {...defaultProps} />);
    const input = screen.getByTitle('Enter page number');
    fireEvent.change(input, { target: { value: '3' } });
    expect(input).toHaveValue('3');
  });

  it('navigates to page on Enter key', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    const input = screen.getByTitle('Enter page number');
    fireEvent.change(input, { target: { value: '3' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('resets invalid page number on Enter', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    const input = screen.getByTitle('Enter page number');
    fireEvent.change(input, { target: { value: '999' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Should not call onPageChange for out of range
    expect(onPageChange).not.toHaveBeenCalled();
    // Input should reset to current page
    expect(input).toHaveValue('1');
  });

  it('navigates on input blur', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    const input = screen.getByTitle('Enter page number');
    fireEvent.change(input, { target: { value: '4' } });
    fireEvent.blur(input);
    expect(onPageChange).toHaveBeenCalledWith(4);
  });

  it('resets invalid page on blur', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} onPageChange={onPageChange} />);
    const input = screen.getByTitle('Enter page number');
    fireEvent.change(input, { target: { value: 'abc' } });
    fireEvent.blur(input);
    // Should not call onPageChange for invalid input
    expect(onPageChange).not.toHaveBeenCalled();
    // Input should reset to current page
    expect(input).toHaveValue('1');
  });

  it('handles jump back 10', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} totalPages={20} totalItems={200} currentPage={15} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByTitle('Back 10 pages'));
    expect(onPageChange).toHaveBeenCalledWith(5);
  });

  it('handles jump forward 10', () => {
    const onPageChange = vi.fn();
    render(<Pagination {...defaultProps} totalPages={20} totalItems={200} currentPage={5} onPageChange={onPageChange} />);
    fireEvent.click(screen.getByTitle('Forward 10 pages'));
    expect(onPageChange).toHaveBeenCalledWith(15);
  });

  it('clamps page to valid range', () => {
    const onPageChange = vi.fn();
    // Already on page 1, clicking First should not call onPageChange
    render(<Pagination {...defaultProps} currentPage={1} onPageChange={onPageChange} />);
    // First page button is disabled when on page 1, but goToPage clamps and checks !== currentPage
    // The button is disabled so click won't trigger, verifying the guard
    fireEvent.click(screen.getByTitle('First page'));
    expect(onPageChange).not.toHaveBeenCalled();
  });

  it('renders minimal mode without shadow', () => {
    const { container } = render(<Pagination {...defaultProps} minimal={true} />);
    // In minimal mode, the wrapper should use bg-transparent instead of shadow
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper.className).toContain('bg-transparent');
    expect(wrapper.className).not.toContain('shadow');
  });

  it('renders infoRight content', () => {
    render(<Pagination {...defaultProps} infoRight={<span>Extra info</span>} />);
    expect(screen.getByText('Extra info')).toBeInTheDocument();
  });
});
