import { describe, it, expect, vi } from 'vitest';
import { render } from '@/test/render';
import { fireEvent, screen, act } from '@testing-library/react';
import { ExportDropdown } from './ExportDropdown';

describe('ExportDropdown', () => {
  it('renders the Export button', () => {
    render(
      <ExportDropdown onExportCsv={vi.fn()} onExportPdf={vi.fn()} />,
    );
    expect(screen.getByText('Export')).toBeInTheDocument();
  });

  it('shows dropdown options when clicked', () => {
    render(
      <ExportDropdown onExportCsv={vi.fn()} onExportPdf={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Export'));
    expect(screen.getByText('CSV')).toBeInTheDocument();
    expect(screen.getByText('PDF')).toBeInTheDocument();
  });

  it('calls onExportCsv when CSV option is clicked', () => {
    const onExportCsv = vi.fn();
    render(
      <ExportDropdown onExportCsv={onExportCsv} onExportPdf={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Export'));
    fireEvent.click(screen.getByText('CSV'));
    expect(onExportCsv).toHaveBeenCalledOnce();
  });

  it('calls onExportPdf when PDF option is clicked', async () => {
    const onExportPdf = vi.fn().mockResolvedValue(undefined);
    render(
      <ExportDropdown onExportCsv={vi.fn()} onExportPdf={onExportPdf} />,
    );
    fireEvent.click(screen.getByText('Export'));
    await act(async () => {
      fireEvent.click(screen.getByText('PDF'));
    });
    expect(onExportPdf).toHaveBeenCalledOnce();
  });

  it('closes dropdown after selecting an option', () => {
    render(
      <ExportDropdown onExportCsv={vi.fn()} onExportPdf={vi.fn()} />,
    );
    fireEvent.click(screen.getByText('Export'));
    expect(screen.getByText('CSV')).toBeInTheDocument();
    fireEvent.click(screen.getByText('CSV'));
    // Dropdown should be closed - CSV option no longer visible
    expect(screen.queryByRole('button', { name: 'CSV' })).not.toBeInTheDocument();
  });

  it('disables the button when disabled prop is true', () => {
    render(
      <ExportDropdown onExportCsv={vi.fn()} onExportPdf={vi.fn()} disabled />,
    );
    expect(screen.getByTitle('Export report')).toBeDisabled();
  });
});
