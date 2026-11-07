import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import type { ActiveDotProps } from 'recharts';
import { ChartActiveDot } from './ChartActiveDot';

function dotProps(overrides: Partial<ActiveDotProps>): ActiveDotProps {
  return {
    cx: 40,
    cy: 20,
    r: 4,
    fill: 'var(--chart-primary)',
    stroke: '#fff',
    strokeWidth: 2,
    payload: {},
    index: 0,
    dataKey: 'value',
    value: 1,
    ...overrides,
  } as ActiveDotProps;
}

function renderInSvg(props: ActiveDotProps) {
  return render(
    <svg>
      <ChartActiveDot {...props} />
    </svg>,
  );
}

describe('ChartActiveDot', () => {
  it('draws a halo and a dot in the series colour, ringed in the card colour rather than white', () => {
    const { container } = renderInSvg(dotProps({}));
    const [halo, dot] = Array.from(container.querySelectorAll('circle'));
    expect(halo.getAttribute('fill')).toBe('var(--chart-primary)');
    expect(halo.getAttribute('fill-opacity')).toBe('0.2');
    expect(Number(halo.getAttribute('r'))).toBeGreaterThan(Number(dot.getAttribute('r')));
    expect(dot.getAttribute('fill')).toBe('var(--chart-primary)');
    expect(dot.getAttribute('stroke')).toBe('var(--chart-surface)');
    expect(dot.getAttribute('cx')).toBe('40');
    expect(dot.getAttribute('cy')).toBe('20');
  });

  it('draws nothing for a point Recharts could not place', () => {
    const { container } = renderInSvg(dotProps({ cy: undefined }));
    expect(container.querySelectorAll('circle')).toHaveLength(0);
  });
});
