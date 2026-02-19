import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('renders nothing for fewer than 2 data points', () => {
    const { container } = render(<Sparkline data={[100]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders nothing for empty data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders an SVG for 2+ data points', () => {
    const { container } = render(<Sparkline data={[100, 200, 150]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('60');
    expect(svg?.getAttribute('height')).toBe('20');
  });

  it('renders a path element for the line', () => {
    const { container } = render(<Sparkline data={[100, 200, 150]} />);
    const paths = container.querySelectorAll('path');
    expect(paths.length).toBeGreaterThanOrEqual(1);
  });

  it('accepts custom dimensions', () => {
    const { container } = render(
      <Sparkline data={[10, 20, 30]} width={100} height={40} />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('100');
    expect(svg?.getAttribute('height')).toBe('40');
  });

  it('renders fill area when fillColor is set', () => {
    const { container } = render(
      <Sparkline data={[10, 20, 30]} fillColor="blue" />,
    );
    const paths = container.querySelectorAll('path');
    // Should have 2 paths: fill area + line
    expect(paths.length).toBe(2);
  });

  it('has aria-hidden attribute', () => {
    const { container } = render(<Sparkline data={[10, 20]} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('aria-hidden')).toBe('true');
  });

  it('handles identical values without error', () => {
    const { container } = render(<Sparkline data={[50, 50, 50, 50]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
  });

  it('applies className prop', () => {
    const { container } = render(
      <Sparkline data={[10, 20]} className="text-red-400" />,
    );
    const svg = container.querySelector('svg');
    expect(svg?.className.baseVal).toContain('text-red-400');
  });
});
