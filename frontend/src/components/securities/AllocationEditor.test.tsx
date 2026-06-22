import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { AllocationEditor, AllocationRow } from './AllocationEditor';
import { COUNTRY_OPTIONS } from '@/lib/constants';

function renderEditor(value: AllocationRow[], onChange = vi.fn()) {
  render(
    <AllocationEditor
      title="Country allocation"
      value={value}
      onChange={onChange}
      options={COUNTRY_OPTIONS}
      namePlaceholder="Select or type a country"
    />,
  );
  return onChange;
}

describe('AllocationEditor', () => {
  it('shows the running total of the rows', () => {
    renderEditor([
      { name: 'United States', weight: '60' },
      { name: 'Canada', weight: '25' },
    ]);
    expect(screen.getByTestId('allocation-total')).toHaveTextContent('85.00');
  });

  it('shows an "Other" remainder when the rows sum to under 100%', () => {
    renderEditor([{ name: 'United States', weight: '60' }]);
    expect(screen.getByTestId('allocation-other')).toHaveTextContent('40.00%');
  });

  it('hides the remainder and shows an error when over 100%', () => {
    renderEditor([
      { name: 'United States', weight: '70' },
      { name: 'Canada', weight: '40' },
    ]);
    expect(screen.queryByTestId('allocation-other')).not.toBeInTheDocument();
    expect(screen.getByTestId('allocation-over-error')).toBeInTheDocument();
  });

  it('appends an empty row when "Add" is clicked', () => {
    const onChange = renderEditor([{ name: 'United States', weight: '60' }]);
    fireEvent.click(screen.getByText('Add country'));
    expect(onChange).toHaveBeenCalledWith([
      { name: 'United States', weight: '60' },
      { name: '', weight: '' },
    ]);
  });

  it('removes a row when its remove control is clicked', () => {
    const onChange = renderEditor([
      { name: 'United States', weight: '60' },
      { name: 'Canada', weight: '25' },
    ]);
    fireEvent.click(screen.getAllByLabelText('Remove row')[0]);
    expect(onChange).toHaveBeenCalledWith([{ name: 'Canada', weight: '25' }]);
  });

  it('emits the new weight when the percentage input changes', () => {
    const onChange = renderEditor([{ name: 'United States', weight: '60' }]);
    fireEvent.change(screen.getByLabelText('Percentage'), {
      target: { value: '70' },
    });
    expect(onChange).toHaveBeenCalledWith([
      { name: 'United States', weight: '70' },
    ]);
  });
});
