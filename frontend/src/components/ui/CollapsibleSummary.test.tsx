import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/render';
import { CollapsibleSummary } from './CollapsibleSummary';

function renderSummary(collapsed: boolean, onToggle = vi.fn()) {
  render(
    <CollapsibleSummary
      title="Summary"
      showLabel="Show summary"
      hideLabel="Hide summary"
      collapsed={collapsed}
      onToggle={onToggle}
    >
      <p>Net Worth</p>
    </CollapsibleSummary>,
  );
  return onToggle;
}

describe('CollapsibleSummary', () => {
  it('draws the cards and offers to hide them while open', () => {
    const onToggle = renderSummary(false);
    const toggle = screen.getByRole('button', { name: /Hide summary/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Net Worth')).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('keeps only its toggle line while folded, still naming an element that exists', () => {
    renderSummary(true);
    const toggle = screen.getByRole('button', { name: /Show summary/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Net Worth')).not.toBeInTheDocument();
    const controlled = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(controlled).not.toBeNull();
    expect(controlled).toHaveAttribute('hidden');
  });

  it('names its region after its title', () => {
    renderSummary(false);
    expect(screen.getByRole('region', { name: 'Summary' })).toBeInTheDocument();
  });
});
