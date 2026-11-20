import { describe, expect, it, vi } from 'vitest';
import { render } from '@/test/render';
import { MoneyFigure } from './MoneyFigure';

vi.mock('@/hooks/useNumberFormat', async () => {
  const { numberFormatMockDefaults } = await import('@/test/number-format-mock');
  return {
    useNumberFormat: () => ({
      ...numberFormatMockDefaults(),
      formatCurrency: (n: number) =>
        n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`,
      numberSeparators: { decimal: '.', group: ',' },
    }),
  };
});

describe('MoneyFigure', () => {
  it('reads as the ordinary formatted figure', () => {
    const { container } = render(<MoneyFigure amount={-637.54} />);
    expect(container.textContent).toBe('-$637.54');
  });

  it('marks each piece for the UI styles to typeset', () => {
    const { container } = render(<MoneyFigure amount={3021.74} display />);
    const root = container.firstElementChild!;
    expect(root.className).toContain('ui-money');
    expect(root.className).toContain('ui-money-display');
    expect(container.querySelector('.ui-money-prefix')?.textContent).toBe('$');
    expect(container.querySelector('.ui-money-whole')?.textContent).toBe('3021');
    expect(container.querySelector('.ui-money-fraction')?.textContent).toBe('.74');
  });

  it('is not a display figure unless asked', () => {
    const { container } = render(<MoneyFigure amount={1} />);
    expect(container.firstElementChild!.className).not.toContain('ui-money-display');
  });
});
