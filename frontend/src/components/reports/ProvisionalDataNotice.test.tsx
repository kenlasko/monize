import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { ProvisionalDataNotice } from './ProvisionalDataNotice';

describe('ProvisionalDataNotice', () => {
  it.each([[0], [undefined], [null]])('renders nothing at a count of %s', (count) => {
    render(<ProvisionalDataNotice count={count} />);
    expect(screen.queryByTestId('provisional-data-notice')).not.toBeInTheDocument();
  });

  it('says how many estimated amounts the figures include and how to list them', () => {
    render(<ProvisionalDataNotice count={2} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('2 amounts in these figures are estimates');
    expect(note).toHaveTextContent('is:provisional');
  });
});
