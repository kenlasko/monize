import { describe, it, expect } from 'vitest';
import { render } from '@/test/render';
import { WIDGET_DOMAINS, WIDGET_ICONS, WidgetIconPuck, WidgetHeading, widgetTintClass } from './widget-meta';
import { DASHBOARD_WIDGETS } from './widget-registry';

describe('widget-meta', () => {
  it('gives every registered widget an icon', () => {
    // A widget added to the registry without an entry here would render a
    // bare header beside decorated ones.
    const missing = DASHBOARD_WIDGETS.map((w) => w.id).filter((id) => !WIDGET_ICONS[id]);
    expect(missing).toEqual([]);
  });

  it('gives every registered widget a domain', () => {
    const missing = DASHBOARD_WIDGETS.map((w) => w.id).filter((id) => !WIDGET_DOMAINS[id]);
    expect(missing).toEqual([]);
  });

  it.each([
    ['favourite-accounts', '--chart-primary'],
    ['portfolio-value', '--chart-5'],
    ['upcoming-bills', '--chart-3'],
    ['insights', '--chart-7'],
  ] as const)('tints %s from the %s chart token', (id, token) => {
    const { container } = render(<WidgetIconPuck id={id} />);
    expect((container.firstElementChild as HTMLElement).className).toContain(`var(${token})`);
    expect(widgetTintClass(id)).toContain(`var(${token})`);
  });

  it('renders the puck as decoration', () => {
    const { container } = render(<WidgetIconPuck id="top-movers" />);
    const puck = container.firstElementChild as HTMLElement;
    expect(puck.getAttribute('aria-hidden')).toBe('true');
    expect(puck.querySelector('svg')).toBeTruthy();
  });

  it('links the heading to the fuller view when given one, and not otherwise', () => {
    const { getByRole, rerender, queryByRole } = render(
      <WidgetHeading id="net-worth" href="/reports/net-worth">Net Worth</WidgetHeading>,
    );
    // The heading stays a heading either way: the link sits inside it, so the
    // document outline does not change when a widget gains a destination.
    expect(getByRole('heading', { name: 'Net Worth' })).toBeInTheDocument();
    expect(getByRole('link', { name: 'Net Worth' })).toHaveAttribute(
      'href',
      '/reports/net-worth',
    );
    rerender(<WidgetHeading id="net-worth">Net Worth</WidgetHeading>);
    expect(queryByRole('link')).toBeNull();
    expect(getByRole('heading', { name: 'Net Worth' })).toBeInTheDocument();
  });
});
