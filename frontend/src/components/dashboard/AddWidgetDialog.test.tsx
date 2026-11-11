import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, within } from '@/test/render';
import { AddWidgetDialog, AddWidgetSlot, AddWidgetTile } from './AddWidgetDialog';
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_WIDGET_IDS } from './widget-registry';
import { widgetTintClass } from './widget-meta';

async function renderDialog(shownIds = DEFAULT_DASHBOARD_WIDGET_IDS, fitWidth?: 'third' | 'half') {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    render(<AddWidgetDialog isOpen onClose={onClose} shownIds={shownIds} onAdd={onAdd} fitWidth={fitWidth} />);
  });
  return { onAdd, onClose };
}

describe('AddWidgetDialog', () => {
  afterEach(() => {
    document.querySelectorAll('[data-widget-id]').forEach((el) => el.remove());
  });

  it('is named by its title and keeps its explanation in a tooltip', async () => {
    await renderDialog();
    expect(screen.getByRole('dialog', { name: 'Add Widget' })).toHaveAccessibleDescription(
      /end of the dashboard/,
    );
  });

  it('offers every widget not on the dashboard, in registry order, and none that is', async () => {
    await renderDialog();
    const offered = screen.getAllByTestId(/^add-widget-/).map((el) => el.getAttribute('data-testid'));
    expect(offered).toEqual(
      DASHBOARD_WIDGETS.filter((w) => !DEFAULT_DASHBOARD_WIDGET_IDS.includes(w.id)).map(
        (w) => `add-widget-${w.id}`,
      ),
    );
  });

  it('shows each offered widget with its tint, its type icon and its name', async () => {
    await renderDialog();
    const option = screen.getByTestId('add-widget-monthly-spending-trend');
    expect(option).toHaveTextContent('Monthly Spending Trend');
    expect(within(option).getByTestId('widget-type-icon-line')).toBeInTheDocument();
    expect(within(option).getByTestId('widget-tint-monthly-spending-trend').className).toContain(
      widgetTintClass('monthly-spending-trend'),
    );
  });

  it('adds the chosen widget, closes, and brings it into view once drawn', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-widget-id', 'favourite-reports');
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;
    document.body.appendChild(target);
    const { onAdd, onClose } = await renderDialog();
    await act(async () => {
      fireEvent.click(screen.getByTestId('add-widget-favourite-reports'));
    });
    expect(onAdd).toHaveBeenCalledWith('favourite-reports');
    expect(onClose).toHaveBeenCalled();
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'nearest' }));
  });

  it('says so when every widget is already shown', async () => {
    await renderDialog(DASHBOARD_WIDGETS.map((w) => w.id));
    expect(screen.queryAllByTestId(/^add-widget-/)).toEqual([]);
    expect(screen.getByText('Every widget is already on your dashboard')).toBeInTheDocument();
  });

  it('closes from its own Close button', async () => {
    const { onClose } = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('AddWidgetDialog from a gap slot', () => {
  it('offers only the hidden widgets that can be as narrow as the space', async () => {
    await renderDialog(DEFAULT_DASHBOARD_WIDGET_IDS, 'third');
    const offered = screen.getAllByTestId(/^add-widget-/).map((el) => el.getAttribute('data-testid'));
    const expected = DASHBOARD_WIDGETS.filter(
      (w) => !DEFAULT_DASHBOARD_WIDGET_IDS.includes(w.id) && w.minWidth === 'third',
    ).map((w) => `add-widget-${w.id}`);
    expect(expected.length).toBeGreaterThan(0);
    expect(offered).toEqual(expected);
    // Monthly Spending Trend is at least half wide: hidden, but it does not fit.
    expect(screen.queryByTestId('add-widget-monthly-spending-trend')).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Add Widget' })).toHaveAccessibleDescription(/fit this space/);
  });

  it('says no hidden widget fits when none can be that narrow', async () => {
    const shown = DASHBOARD_WIDGETS.filter((w) => w.minWidth === 'third').map((w) => w.id);
    await renderDialog(shown, 'third');
    expect(screen.queryAllByTestId(/^add-widget-/)).toEqual([]);
    expect(screen.getByText('No hidden widget fits this space. Drag a widget here to move it in.')).toBeInTheDocument();
  });
});

describe('AddWidgetSlot', () => {
  const gap = { index: 3, span: 8, width: 'twoThirds' } as const;

  it('is a dashed button exactly the gap wide, named for its space, that hands back its gap', () => {
    const onClick = vi.fn();
    render(<AddWidgetSlot gap={gap} highlighted={false} onClick={onClick} />);
    const slot = screen.getByRole('button', { name: 'Add Widget to this space (Two thirds width)' });
    expect(slot).toHaveClass('lg:col-span-8', 'border-dashed', 'focus-visible:ring-2', 'motion-reduce:transition-none');
    expect(slot).toHaveAttribute('data-gap-index', '3');
    expect(slot).toHaveAttribute('data-gap-width', 'twoThirds');
    expect(slot).not.toHaveAttribute('data-drop-target');
    // No floor of its own: it stretches with its row.
    expect(slot.className).not.toMatch(/min-h-/);
    fireEvent.click(slot);
    expect(onClick).toHaveBeenCalledWith(gap);
  });

  it('is marked while a dragged widget would drop into it', () => {
    render(<AddWidgetSlot gap={gap} highlighted onClick={vi.fn()} />);
    const slot = screen.getByRole('button', { name: /^Add Widget to this space/ });
    expect(slot).toHaveAttribute('data-drop-target', 'true');
    expect(slot).toHaveClass('border-blue-500');
  });
});

describe('AddWidgetTile', () => {
  it('is a dashed button that opens the dialog', () => {
    const onClick = vi.fn();
    render(<AddWidgetTile onClick={onClick} empty={false} />);
    const tile = screen.getByRole('button', { name: 'Add Widget' });
    expect(tile).toHaveClass('border-dashed', 'focus-visible:ring-2');
    fireEvent.click(tile);
    expect(onClick).toHaveBeenCalled();
    expect(screen.queryByText(/at least one widget/)).not.toBeInTheDocument();
  });

  it('says beside it that a widget is needed when none is left', () => {
    render(<AddWidgetTile onClick={vi.fn()} empty />);
    expect(screen.getByRole('status')).toHaveTextContent('Select at least one widget to show on the dashboard.');
  });
});
