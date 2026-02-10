import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DateRangeSelector } from './DateRangeSelector';

describe('DateRangeSelector', () => {
  const ranges = ['1m', '3m', '6m', '1y'] as const;

  it('renders range buttons', () => {
    render(<DateRangeSelector ranges={ranges} value="3m" onChange={vi.fn()} />);
    expect(screen.getByText('1M')).toBeInTheDocument();
    expect(screen.getByText('3M')).toBeInTheDocument();
    expect(screen.getByText('6M')).toBeInTheDocument();
    expect(screen.getByText('1Y')).toBeInTheDocument();
  });

  it('calls onChange when button clicked', () => {
    const onChange = vi.fn();
    render(<DateRangeSelector ranges={ranges} value="3m" onChange={onChange} />);
    fireEvent.click(screen.getByText('6M'));
    expect(onChange).toHaveBeenCalledWith('6m');
  });

  it('formats ytd and all labels correctly', () => {
    render(<DateRangeSelector ranges={['ytd', 'all']} value="ytd" onChange={vi.fn()} />);
    expect(screen.getByText('YTD')).toBeInTheDocument();
    expect(screen.getByText('All Time')).toBeInTheDocument();
  });

  it('shows custom button when showCustom is true', () => {
    render(<DateRangeSelector ranges={ranges} value="1m" onChange={vi.fn()} showCustom />);
    expect(screen.getByText('Custom')).toBeInTheDocument();
  });

  it('shows date inputs when custom is selected', () => {
    render(
      <DateRangeSelector
        ranges={ranges}
        value="custom"
        onChange={vi.fn()}
        showCustom
        customStartDate=""
        customEndDate=""
      />
    );
    expect(screen.getByText('Start Date')).toBeInTheDocument();
    expect(screen.getByText('End Date')).toBeInTheDocument();
  });

  it('hides date inputs when custom is not selected', () => {
    render(
      <DateRangeSelector ranges={ranges} value="3m" onChange={vi.fn()} showCustom />
    );
    expect(screen.queryByText('Start Date')).not.toBeInTheDocument();
  });
});
