import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentReportColumnChooser } from './InvestmentReportColumnChooser';
import { INVESTMENT_REPORT_COLUMNS } from '@/types/investment-report';

describe('InvestmentReportColumnChooser', () => {
  it('always pins symbol first and marks it as locked', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['marketValue']} onChange={onChange} />);
    expect(screen.getByText('(always shown)')).toBeInTheDocument();
    // Symbol appears in the selected list even though it was not passed first
    expect(screen.getByText('Selected columns (2)')).toBeInTheDocument();
  });

  it('adds an available column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Add Market Value'));
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue']);
  });

  it('removes a selected column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove Gain'));
    expect(onChange).toHaveBeenCalledWith(['symbol']);
  });

  it('does not allow removing the symbol column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    expect(screen.queryByLabelText('Remove Symbol')).not.toBeInTheDocument();
  });

  it('reorders columns with the move buttons', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser
        value={['symbol', 'gain', 'marketValue']}
        onChange={onChange}
      />,
    );
    // Move "Market Value" (index 2) up to index 1
    fireEvent.click(screen.getByLabelText('Move Market Value up'));
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue', 'gain']);
  });

  it('moves a column down with the down button', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser
        value={['symbol', 'gain', 'marketValue']}
        onChange={onChange}
      />,
    );
    // Move "Gain" (index 1) down to index 2
    fireEvent.click(screen.getByLabelText('Move Gain down'));
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue', 'gain']);
  });

  it('never moves a column above the pinned symbol', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    // The first non-symbol item's up button is disabled (cannot pass symbol)
    expect(screen.getByLabelText('Move Gain up')).toBeDisabled();
  });

  it('falls back to the raw key for an unknown selected column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'legacyKey']} onChange={onChange} />);
    // A column key no longer in the catalogue still renders by its key.
    expect(screen.getByText('legacyKey')).toBeInTheDocument();
  });

  it('shows an empty state when every column is selected', () => {
    const onChange = vi.fn();
    const allKeys = INVESTMENT_REPORT_COLUMNS.map((c) => c.key);
    render(<InvestmentReportColumnChooser value={allKeys} onChange={onChange} />);
    expect(screen.getByText('All columns selected')).toBeInTheDocument();
  });
});
