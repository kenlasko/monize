import { describe, it, expect } from 'vitest';
import { render, renderHook, screen } from '@/test/render';
import { WidgetGlyph, WidgetTint, WidgetTypeIcon, useWidgetName } from './widget-glyphs';
import { DASHBOARD_WIDGETS } from './widget-registry';
import { widgetTintClass } from './widget-meta';

describe('widget glyphs', () => {
  it('tints a glyph with its widget domain colour', () => {
    render(
      <WidgetTint id="expenses-pie">
        <WidgetTypeIcon type="pie" />
      </WidgetTint>,
    );
    expect(screen.getByTestId('widget-tint-expenses-pie').className).toContain(widgetTintClass('expenses-pie'));
    expect(screen.getByTestId('widget-type-icon-pie')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['bar', 'line', 'pie', 'table', 'list'] as const)('draws the %s type icon', (type) => {
    render(<WidgetTypeIcon type={type} />);
    expect(screen.getByTestId(`widget-type-icon-${type}`)).toBeInTheDocument();
  });

  it('pairs a widget tint with the icon for its own visualization', () => {
    render(<WidgetGlyph id="income-expenses" />);
    expect(screen.getByTestId('widget-tint-income-expenses')).toContainElement(
      screen.getByTestId('widget-type-icon-bar'),
    );
  });

  it('names every registered widget from its title section', () => {
    const { result } = renderHook(() => useWidgetName());
    for (const w of DASHBOARD_WIDGETS) {
      expect(result.current(w.id)).not.toBe(w.id);
    }
    expect(result.current('upcoming-bills')).toBe('Upcoming Bills & Deposits');
  });
});
