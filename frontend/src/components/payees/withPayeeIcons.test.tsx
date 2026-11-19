import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { payeeOptionIcon, withPayeeIcons } from './withPayeeIcons';

describe('payeeOptionIcon', () => {
  it('reads the cached favicon from our own logo route when the payee has one', () => {
    const { container } = render(<>{payeeOptionIcon({ id: 'p-1', name: 'Costco', hasLogo: true })}</>);
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/v1/payees/p-1/logo');
  });

  it("falls back to the payee's initial without a request when it has none", () => {
    const { container } = render(<>{payeeOptionIcon({ id: 'p-2', name: 'bakery', hasLogo: false })}</>);
    expect(container.querySelector('img')).toBeNull();
    expect(container).toHaveTextContent('B');
  });
});

describe('withPayeeIcons', () => {
  it('adds an icon to each payee row and leaves a placeholder row alone', () => {
    const options = withPayeeIcons(
      [
        { value: '', label: 'Choose' },
        { value: 'p-1', label: 'Costco' },
      ],
      [{ id: 'p-1', name: 'Costco', hasLogo: true }],
    );
    expect(options[0]).toEqual({ value: '', label: 'Choose' });
    expect(options[1].icon).toBeDefined();
  });
});
