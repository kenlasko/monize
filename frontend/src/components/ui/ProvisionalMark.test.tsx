import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ProvisionalMark } from './ProvisionalMark';

describe('ProvisionalMark', () => {
  it.each([[0], [undefined], [null], [-1], [Number.NaN]])('renders nothing at a count of %s', (count) => {
    render(<ProvisionalMark count={count} />);
    expect(screen.queryByTestId('provisional-mark')).not.toBeInTheDocument();
  });

  it('marks a figure holding one estimate, says how many and names is:provisional', () => {
    render(<ProvisionalMark count={1} />);
    expect(screen.getByTestId('provisional-mark-symbol')).toBeInTheDocument();
    expect(screen.getByText('(includes estimated amounts)')).toBeInTheDocument();
    const explanation = screen.getByRole('button').getAttribute('aria-label') ?? '';
    expect(explanation).toContain('1 amount in this figure is an estimate');
    expect(explanation).toContain('is:provisional');
  });

  it('pluralises the count', () => {
    render(<ProvisionalMark count={3} />);
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain(
      '3 amounts in this figure are estimates',
    );
  });
});
