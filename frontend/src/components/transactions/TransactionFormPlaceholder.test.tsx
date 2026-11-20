import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { TransactionFormPlaceholder } from './TransactionFormPlaceholder';

describe('TransactionFormPlaceholder', () => {
  it('announces loading and draws the form rows at their own heights', () => {
    const { container } = render(<TransactionFormPlaceholder />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading...');
    // Nine fields, each a label line over a 42px input, as the form draws them.
    expect(container.querySelectorAll('.h-\\[42px\\]')).toHaveLength(9);
  });
});
