import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';

const normalizeSpy = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/lib/helpers/search-match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/helpers/search-match')>();
  return {
    ...actual,
    normalizeForSearch: (text: string) => {
      normalizeSpy.calls += 1;
      return actual.normalizeForSearch(text);
    },
  };
});

import { Combobox } from '@/components/ui/Combobox';

Element.prototype.scrollIntoView = vi.fn();

const options = Array.from({ length: 50 }, (_, i) => ({
  value: String(i),
  label: `Payee ${i}`,
  subtitle: `Category ${i}`,
  keywords: [`alias-${i}`],
}));

describe('Combobox search index', () => {
  beforeEach(() => {
    normalizeSpy.calls = 0;
  });

  it('normalises each option once per options list, not on every keystroke or highlight move', async () => {
    const onChange = vi.fn();
    const { rerender } = render(<Combobox options={options} onChange={onChange} />);
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    await new Promise((r) => setTimeout(r, 150));

    fireEvent.change(input, { target: { value: 'pay' } });
    const afterFirstQuery = normalizeSpy.calls;
    // label + subtitle + one keyword per option, once.
    expect(afterFirstQuery).toBe(options.length * 3);

    fireEvent.change(input, { target: { value: 'paye' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    rerender(<Combobox options={options} onChange={onChange} />);
    expect(normalizeSpy.calls).toBe(afterFirstQuery);

    // Still filtering and ranking correctly from the cached keys.
    fireEvent.change(input, { target: { value: 'alias-7' } });
    expect(screen.getByText('Payee 7')).toBeInTheDocument();
    expect(screen.queryByText('Payee 8')).not.toBeInTheDocument();
  });

  it('ranks a label prefix match before a match elsewhere, then A-Z', async () => {
    render(
      <Combobox
        options={[
          { value: '1', label: 'Zeta Market', keywords: ['market'] },
          { value: '2', label: 'Market Place' },
          { value: '3', label: 'Big Market' },
        ]}
        onChange={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    await new Promise((r) => setTimeout(r, 150));
    fireEvent.change(input, { target: { value: 'market' } });
    const labels = Array.from(document.querySelectorAll('[data-option-index]')).map((el) => el.textContent);
    expect(labels).toEqual(['Market Place', 'Big Market', 'Zeta Market']);
  });
});
