import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { render, screen } from '@/test/render';
import { AssistantTable } from './AssistantTable';

const exportToCsvMock = vi.fn();
vi.mock('@/lib/csv-export', () => ({
  exportToCsv: (...args: unknown[]) => exportToCsvMock(...args),
}));

describe('AssistantTable', () => {
  beforeEach(() => {
    exportToCsvMock.mockReset();
  });

  it('renders the table content and a download button', () => {
    render(
      <AssistantTable>
        <thead>
          <tr>
            <th>Category</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Food</td>
            <td>$100</td>
          </tr>
        </tbody>
      </AssistantTable>,
    );

    expect(screen.getByText('Category')).toBeInTheDocument();
    expect(screen.getByText('Food')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /download table as csv/i }),
    ).toBeInTheDocument();
  });

  it('extracts headers and rows from the rendered DOM when exporting', () => {
    render(
      <AssistantTable>
        <thead>
          <tr>
            <th> Category </th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Food</td>
            <td>$100</td>
          </tr>
          <tr>
            <td>Gas</td>
            <td>$50</td>
          </tr>
        </tbody>
      </AssistantTable>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /download table as csv/i }),
    );

    expect(exportToCsvMock).toHaveBeenCalledTimes(1);
    expect(exportToCsvMock).toHaveBeenCalledWith(
      'category',
      ['Category', 'Amount'],
      [
        ['Food', '$100'],
        ['Gas', '$50'],
      ],
    );
  });

  it('exports row-header cells in the body as part of the row', () => {
    render(
      <AssistantTable>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Net Worth</th>
            <td>$10,000</td>
          </tr>
        </tbody>
      </AssistantTable>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /download table as csv/i }),
    );

    expect(exportToCsvMock).toHaveBeenCalledWith(
      'metric',
      ['Metric', 'Value'],
      [['Net Worth', '$10,000']],
    );
  });

  it('uses a preceding heading as the CSV filename', () => {
    render(
      <div>
        <h2>Spending by Category</h2>
        <AssistantTable>
          <thead>
            <tr>
              <th>Category</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Food</td>
              <td>$100</td>
            </tr>
          </tbody>
        </AssistantTable>
      </div>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /download table as csv/i }),
    );

    expect(exportToCsvMock).toHaveBeenCalledWith(
      'spending-by-category',
      ['Category', 'Amount'],
      [['Food', '$100']],
    );
  });

  it('falls back to "ai-table" when neither heading nor header cell is available', () => {
    render(
      <AssistantTable>
        <thead>
          <tr>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>A</td>
            <td>B</td>
          </tr>
        </tbody>
      </AssistantTable>,
    );

    fireEvent.click(
      screen.getByRole('button', { name: /download table as csv/i }),
    );

    expect(exportToCsvMock).toHaveBeenCalledWith(
      'ai-table',
      ['', ''],
      [['A', 'B']],
    );
  });
});
