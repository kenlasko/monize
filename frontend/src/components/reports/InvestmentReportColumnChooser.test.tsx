import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InvestmentReportColumnChooser } from './InvestmentReportColumnChooser';
import { INVESTMENT_REPORT_COLUMNS } from '@/types/investment-report';

describe('InvestmentReportColumnChooser', () => {
  it('lists the selected columns in the given order', () => {
    render(<InvestmentReportColumnChooser value={['symbol', 'marketValue']} onChange={vi.fn()} />);
    expect(screen.getByText('Selected columns (2)')).toBeInTheDocument();
    expect(screen.getByTestId('selected-symbol')).toBeInTheDocument();
    expect(screen.getByTestId('selected-marketValue')).toBeInTheDocument();
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

  it('allows removing the symbol column', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove Symbol'));
    expect(onChange).toHaveBeenCalledWith(['gain']);
  });

  it('reorders columns by dragging one onto another', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser
        value={['symbol', 'gain', 'marketValue']}
        onChange={onChange}
      />,
    );
    const source = screen.getByTestId('selected-marketValue');
    const target = screen.getByTestId('selected-gain');
    fireEvent.dragStart(source);
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(onChange).toHaveBeenCalledWith(['symbol', 'marketValue', 'gain']);
  });

  it('can move a column ahead of symbol', () => {
    const onChange = vi.fn();
    render(<InvestmentReportColumnChooser value={['symbol', 'gain']} onChange={onChange} />);
    fireEvent.dragStart(screen.getByTestId('selected-gain'));
    fireEvent.drop(screen.getByTestId('selected-symbol'));
    expect(onChange).toHaveBeenCalledWith(['gain', 'symbol']);
  });

  it('can drag the symbol column itself', () => {
    const onChange = vi.fn();
    render(
      <InvestmentReportColumnChooser value={['symbol', 'gain', 'name']} onChange={onChange} />,
    );
    fireEvent.dragStart(screen.getByTestId('selected-symbol'));
    fireEvent.drop(screen.getByTestId('selected-name'));
    expect(onChange).toHaveBeenCalledWith(['gain', 'name', 'symbol']);
  });

  it('falls back to the raw key for an unknown selected column', () => {
    render(<InvestmentReportColumnChooser value={['symbol', 'legacyKey']} onChange={vi.fn()} />);
    expect(screen.getByText('legacyKey')).toBeInTheDocument();
  });

  it('prompts to add a column when none are selected', () => {
    render(<InvestmentReportColumnChooser value={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/Add at least one column/)).toBeInTheDocument();
  });

  it('shows an empty state when every column is selected', () => {
    const allKeys = INVESTMENT_REPORT_COLUMNS.map((c) => c.key);
    render(<InvestmentReportColumnChooser value={allKeys} onChange={vi.fn()} />);
    expect(screen.getByText('All columns selected')).toBeInTheDocument();
  });
});
