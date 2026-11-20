import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { QuickAddDialogPlaceholder } from './QuickAddDialogPlaceholder';

describe('QuickAddDialogPlaceholder', () => {
  it('opens the Quick Add dialog at its own size and announces loading', () => {
    render(<QuickAddDialogPlaceholder />);
    expect(screen.getByRole('dialog', { name: 'Quick Add' })).toBeInTheDocument();
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading...');
    // The Entry field at the height the dialog's large input draws.
    expect(document.querySelectorAll('.h-\\[54px\\]')).toHaveLength(1);
  });
});
