import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { InfoTooltip } from './InfoTooltip';

describe('InfoTooltip', () => {
  it('renders tooltip text', () => {
    render(<InfoTooltip text="Help text here" />);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Help text here');
  });

  it('exposes the text via aria-label without a native title', () => {
    render(<InfoTooltip text="Helpful info" />);
    const span = screen.getByLabelText('Helpful info');
    expect(span).toHaveAttribute('aria-label', 'Helpful info');
    expect(span).not.toHaveAttribute('title');
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

  it('anchors the popover to the right edge when align is right', () => {
    render(<InfoTooltip text="Tooltip" align="right" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('right-0');
    expect(tooltipEl.className).not.toContain('left-0');
  });

  it('keeps the default left anchor for bottom placement', () => {
    render(<InfoTooltip text="Tooltip" />);
    const tooltipEl = screen.getByRole('tooltip');
    expect(tooltipEl.className).toContain('left-0');
    expect(tooltipEl.className).not.toContain('right-0');
  });

  it('applies custom icon className', () => {
    const { container } = render(<InfoTooltip text="Tooltip" iconClassName="h-6 w-6" />);
    expect(container.querySelector('.h-6.w-6')).toBeInTheDocument();
  });
});
