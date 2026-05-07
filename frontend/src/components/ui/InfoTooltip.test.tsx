import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('renders tooltip text', () => {
    render(<InfoTooltip text="Help text here" />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text here');
  });

  it('sets title and aria-label attributes', () => {
    render(<InfoTooltip text="Helpful info" />);
    const span = screen.getByTitle('Helpful info');
    expect(span).toHaveAttribute('aria-label', 'Helpful info');
  });

  it('applies bottom placement classes by default', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('top-full');
  });

  it('applies top placement classes when placement is top', () => {
    render(<InfoTooltip text="Tooltip" placement="top" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('bottom-full');
  });

  it('applies custom icon className', () => {
    const { container } = render(<InfoTooltip text="Tooltip" iconClassName="h-6 w-6" />);
    expect(container.querySelector('.h-6.w-6')).toBeInTheDocument();
  });
});
