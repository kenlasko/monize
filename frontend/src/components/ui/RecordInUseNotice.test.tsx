import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { RecordInUseNotice } from './RecordInUseNotice';

describe('RecordInUseNotice', () => {
  it('lists each kind with its count and links it where the resolver says', () => {
    render(
      <RecordInUseNotice
        entries={[
          { kind: 'transactions', count: 3 },
          { kind: 'rules', count: 1 },
          { kind: 'sharedPeople', count: 2 },
        ]}
        hrefFor={(e) => (e.kind === 'sharedPeople' ? undefined : `/x/${e.kind}`)}
      />,
    );
    expect(screen.getByRole('link', { name: '3 transactions' })).toHaveAttribute('href', '/x/transactions');
    expect(screen.getByRole('link', { name: '1 rule' })).toHaveAttribute('href', '/x/rules');
    expect(screen.getByText('2 shared-expense people')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /shared-expense/ })).not.toBeInTheDocument();
  });
});
