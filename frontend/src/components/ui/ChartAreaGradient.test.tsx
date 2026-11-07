import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { ChartAreaGradient } from './ChartAreaGradient';

describe('ChartAreaGradient', () => {
  it('fades the series colour from the top to nothing at the baseline', () => {
    const { container } = render(
      <svg>
        <defs>
          <ChartAreaGradient id="g" color="var(--chart-income)" />
        </defs>
      </svg>,
    );
    const gradient = container.querySelector('linearGradient#g');
    expect(gradient?.getAttribute('y2')).toBe('1');
    const stops = Array.from(container.querySelectorAll('stop'));
    expect(stops.map((s) => s.getAttribute('stop-color'))).toEqual([
      'var(--chart-income)',
      'var(--chart-income)',
    ]);
    expect(stops.map((s) => s.getAttribute('stop-opacity'))).toEqual(['0.35', '0']);
  });

  it('takes a caller opacity for the top stop', () => {
    const { container } = render(
      <svg>
        <ChartAreaGradient id="g" color="var(--chart-1)" opacity={0.2} />
      </svg>,
    );
    expect(container.querySelector('stop')?.getAttribute('stop-opacity')).toBe('0.2');
  });
});
