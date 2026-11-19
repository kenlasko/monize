import { describe, it, expect, vi, beforeAll } from 'vitest';
import { useForm } from 'react-hook-form';
import { render, screen, fireEvent, act } from '@/test/render';
import { IconSelect, placeList, SEPARATOR_VALUE, type IconSelectOption } from './IconSelect';

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

const options: IconSelectOption[] = [
  { value: '', label: 'Select account' },
  { value: 'a-1', label: 'Chequing', icon: <span data-testid="icon-a-1">C</span> },
  { value: SEPARATOR_VALUE, label: '----', disabled: true },
  { value: 'a-2', label: 'Savings', icon: <span data-testid="icon-a-2">S</span> },
  { value: 'a-3', label: 'Closed card', disabled: true },
];

function many(count: number): IconSelectOption[] {
  return Array.from({ length: count }, (_, i) => ({ value: `v-${i}`, label: `Account ${i}` }));
}

describe('IconSelect', () => {
  it('is a combobox named by its label, with the native select hidden from assistive technology', () => {
    render(<IconSelect label="Account" options={options} value="" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger).toHaveTextContent('Select account');
    const native = document.querySelector('select[data-icon-select-native]')!;
    expect(native).toHaveAttribute('aria-hidden', 'true');
    expect(native).toHaveAttribute('tabindex', '-1');
  });

  it("shows the picked row's icon and label in the closed field", () => {
    render(<IconSelect label="Account" options={options} value="a-2" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger).toHaveTextContent('Savings');
    expect(screen.getByTestId('icon-a-2')).toBeInTheDocument();
  });

  it('lists every row with its icon, draws the separator as a rule, and reports a pick as a change event', () => {
    const onChange = vi.fn((event: React.ChangeEvent<HTMLSelectElement>) => event.target.value);
    render(<IconSelect label="Account" options={options} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    const list = screen.getByRole('listbox');
    expect(list.parentElement?.parentElement).toBe(document.body);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Select account',
      'CChequing',
      'SSavings',
      'Closed card',
    ]);
    expect(screen.getByRole('separator')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: /Savings/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.results[0].value).toBe('a-2');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveFocus();
  });

  it('refuses a disabled row', () => {
    const onChange = vi.fn();
    render(<IconSelect label="Account" options={options} value="" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    const closed = screen.getByRole('option', { name: 'Closed card' });
    expect(closed).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(closed);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('moves with the arrow keys, skipping the rule and disabled rows, and picks with Enter', () => {
    const onChange = vi.fn((event: React.ChangeEvent<HTMLSelectElement>) => event.target.value);
    render(<IconSelect label="Account" options={options} value="a-1" onChange={onChange} />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Chequing/ }).id).toBe(
      trigger.getAttribute('aria-activedescendant'),
    );
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: /Savings/ }).id).toBe(
      trigger.getAttribute('aria-activedescendant'),
    );
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange.mock.results[0].value).toBe('a-2');
  });

  it('closes on Escape without letting the key reach a surrounding dialog', () => {
    const onDialogKey = vi.fn();
    document.addEventListener('keydown', onDialogKey);
    try {
      render(<IconSelect label="Account" options={options} value="" onChange={vi.fn()} />);
      const trigger = screen.getByRole('combobox', { name: 'Account' });
      fireEvent.click(trigger);
      fireEvent.keyDown(trigger, { key: 'Escape' });
      expect(screen.queryByRole('listbox')).toBeNull();
      expect(onDialogKey).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onDialogKey);
    }
  });

  it('offers a filter on a long list and picks the first match with Enter', () => {
    const onChange = vi.fn((event: React.ChangeEvent<HTMLSelectElement>) => event.target.value);
    render(<IconSelect label="Account" options={many(12)} value="v-0" onChange={onChange} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    const filter = screen.getByRole('searchbox');
    expect(filter).toHaveFocus();
    fireEvent.change(filter, { target: { value: '11' } });
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['Account 11']);
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(onChange.mock.results[0].value).toBe('v-11');
  });

  it('returns to the field when Tab leaves the filter, so focus moves on from there', () => {
    render(<IconSelect label="Account" options={many(12)} value="v-0" onChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('hands focus to the field when a form focuses the hidden select', () => {
    render(<IconSelect label="Account" options={options} value="" onChange={vi.fn()} />);
    const native = document.querySelector<HTMLSelectElement>('select[data-icon-select-native]')!;
    act(() => native.focus());
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveFocus();
  });

  it('says so when the filter matches nothing', () => {
    render(<IconSelect label="Account" options={many(12)} value="v-0" onChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('tracks its own picks when uncontrolled', () => {
    render(<IconSelect label="Account" options={options} defaultValue="a-1" />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger).toHaveTextContent('Chequing');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Savings/ }));
    expect(trigger).toHaveTextContent('Savings');
  });

  it('does nothing when disabled', () => {
    render(<IconSelect label="Account" options={options} value="" onChange={vi.fn()} disabled />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Account' }));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('feeds a react-hook-form field through register, as a native select does', async () => {
    const onSubmit = vi.fn();
    function Form() {
      const { register, handleSubmit, watch } = useForm({ defaultValues: { accountId: 'a-1' } });
      return (
        <form onSubmit={handleSubmit(onSubmit)}>
          <IconSelect label="Account" options={options} value={watch('accountId')} {...register('accountId')} />
          <button type="submit">Save</button>
        </form>
      );
    }
    render(<Form />);
    const trigger = screen.getByRole('combobox', { name: 'Account' });
    expect(trigger).toHaveTextContent('Chequing');
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('option', { name: /Savings/ }));
    expect(trigger).toHaveTextContent('Savings');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(onSubmit.mock.calls[0][0]).toEqual({ accountId: 'a-2' });
  });

  it('describes the field by its error', () => {
    render(<IconSelect label="Account" options={options} value="" onChange={vi.fn()} error="Pick one" />);
    expect(screen.getByRole('combobox', { name: 'Account' })).toHaveAccessibleDescription('Pick one');
  });

  describe('placeList', () => {
    it('hangs under the field at its width, never narrower than a readable list', () => {
      expect(placeList({ left: 20, top: 100, bottom: 136, width: 400 }, 1280, 800)).toEqual({
        left: 20,
        width: 400,
        maxHeight: 320,
        top: 140,
      });
      expect(placeList({ left: 20, top: 100, bottom: 136, width: 120 }, 1280, 800).width).toBe(240);
    });

    it('slides left inside the viewport and flips above a field near the bottom', () => {
      const placed = placeList({ left: 300, top: 700, bottom: 736, width: 200 }, 360, 800);
      expect(placed.left + placed.width).toBeLessThanOrEqual(352);
      expect(placed.top).toBeUndefined();
      expect(placed.bottom).toBe(800 - 700 + 4);
    });
  });
});
