import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { render, screen, fireEvent, within } from '@/test/render';
import { AddWidgetDialog, AddWidgetTile } from './AddWidgetDialog';
import { DASHBOARD_WIDGETS, DEFAULT_DASHBOARD_WIDGET_IDS } from './widget-registry';
import { widgetTintClass } from './widget-meta';

async function renderDialog(shownIds = DEFAULT_DASHBOARD_WIDGET_IDS) {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  await act(async () => {
    render(<AddWidgetDialog isOpen onClose={onClose} shownIds={shownIds} onAdd={onAdd} />);
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
