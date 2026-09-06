import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, screen } from '@testing-library/react';
import { render } from '@/test/render';
import { Tabs, TabPanel, tabId, tabPanelId, overflowEdge } from './Tabs';

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'transactions', label: 'Transactions' },
  { key: 'prices', label: 'Price history' },
] as const;

type Key = (typeof TABS)[number]['key'];

function renderTabs(value: Key = 'overview', onChange = vi.fn()) {
  const result = render(
    <Tabs
      tabs={TABS}
      value={value}
      onChange={onChange}
      idPrefix="security"
      ariaLabel="Security sections"
    />,
  );
  return { ...result, onChange };
}

describe('Tabs', () => {
  it('renders every tab inside a labelled tablist', () => {
    renderTabs();
    const tablist = screen.getByRole('tablist', { name: 'Security sections' });
    expect(tablist).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('marks only the selected tab as selected', () => {
    renderTabs('transactions');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('gives the set a single tab stop via roving tabindex', () => {
    renderTabs('transactions');
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
    expect(screen.getByRole('tab', { name: 'Price history' })).toHaveAttribute(
      'tabindex',
      '-1',
    );
  });

  it('reports the clicked tab', () => {
    const { onChange } = renderTabs();
    fireEvent.click(screen.getByRole('tab', { name: 'Price history' }));
    expect(onChange).toHaveBeenCalledWith('prices');
  });

  it('wires the selected tab to its panel', () => {
    renderTabs();
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-controls',
      tabPanelId('security', 'overview'),
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'id',
      tabId('security', 'overview'),
    );
  });

  it('does not point unselected tabs at panels that are not rendered', () => {
    renderTabs('overview');
    // Their panels are unmounted, and aria-controls must not dangle.
    expect(
      screen.getByRole('tab', { name: 'Transactions' }),
    ).not.toHaveAttribute('aria-controls');
    expect(
      screen.getByRole('tab', { name: 'Price history' }),
    ).not.toHaveAttribute('aria-controls');
  });

  describe('keyboard navigation', () => {
    it('moves to the next tab on ArrowRight', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('transactions');
    });

    it('moves to the previous tab on ArrowLeft', () => {
      const { onChange } = renderTabs('transactions');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Transactions' }), {
        key: 'ArrowLeft',
      });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('wraps from the last tab to the first', () => {
      const { onChange } = renderTabs('prices');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Price history' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('wraps from the first tab to the last', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowLeft',
      });
      expect(onChange).toHaveBeenCalledWith('prices');
    });

    it('jumps to the ends on Home and End', () => {
      const { onChange } = renderTabs('transactions');
      const current = screen.getByRole('tab', { name: 'Transactions' });
      fireEvent.keyDown(current, { key: 'End' });
      expect(onChange).toHaveBeenCalledWith('prices');
      fireEvent.keyDown(current, { key: 'Home' });
      expect(onChange).toHaveBeenCalledWith('overview');
    });

    it('moves focus along with the selection', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'ArrowRight',
      });
      expect(onChange).toHaveBeenCalledWith('transactions');
      expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveFocus();
    });

    it('leaves other keys to the browser', () => {
      const { onChange } = renderTabs('overview');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Overview' }), {
        key: 'a',
      });
      expect(onChange).not.toHaveBeenCalled();
    });
  });
});

describe('Tabs overflow cue', () => {
  // jsdom lays nothing out: scrollWidth and clientWidth are both 0, so the
  // scroller is given the geometry of a phone showing four of five tabs.
  function fakeGeometry(el: HTMLElement, geometry: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: geometry.scrollWidth });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: geometry.clientWidth });
    Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: geometry.scrollLeft });
  }

  it('classifies which edge still has content behind it', () => {
    expect(overflowEdge({ scrollWidth: 300, clientWidth: 300, scrollLeft: 0 })).toBe('none');
    // Sub-pixel layouts report one pixel of phantom overflow on a row that
    // does not scroll; that is not a hidden tab.
    expect(overflowEdge({ scrollWidth: 301, clientWidth: 300, scrollLeft: 0 })).toBe('none');
    expect(overflowEdge({ scrollWidth: 500, clientWidth: 300, scrollLeft: 0 })).toBe('end');
    expect(overflowEdge({ scrollWidth: 500, clientWidth: 300, scrollLeft: 200 })).toBe('start');
    expect(overflowEdge({ scrollWidth: 500, clientWidth: 300, scrollLeft: 199 })).toBe('start');
    expect(overflowEdge({ scrollWidth: 500, clientWidth: 300, scrollLeft: 80 })).toBe('both');
  });

  it('fades the far edge when tabs hide beyond it, and the near edge once scrolled there', () => {
    renderTabs();
    const scroller = screen.getByRole('tablist').parentElement as HTMLElement;
    expect(scroller.className).toContain('scroll-fade-x');
    // Nothing hidden: no fade.
    expect(scroller.dataset.overflow).toBe('none');

    fakeGeometry(scroller, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 });
    fireEvent.scroll(scroller);
    expect(scroller.dataset.overflow).toBe('end');

    scroller.scrollLeft = 200;
    fireEvent.scroll(scroller);
    expect(scroller.dataset.overflow).toBe('start');

    scroller.scrollLeft = 100;
    fireEvent.scroll(scroller);
    expect(scroller.dataset.overflow).toBe('both');
  });

  it('brings the selected tab on screen when the selection changes', () => {
    const scrolled: string[] = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this.textContent ?? '');
    };
    try {
      function Harness() {
        const [value, setValue] = useState<Key>('overview');
        return (
          <Tabs tabs={TABS} value={value} onChange={setValue} idPrefix="security" ariaLabel="Security sections" />
        );
      }
      render(<Harness />);
      expect(scrolled).toEqual(['Overview']);
      fireEvent.click(screen.getByRole('tab', { name: 'Price history' }));
      expect(scrolled).toEqual(['Overview', 'Price history']);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});

describe('TabPanel', () => {
  it('renders its children when active, labelled by its tab', () => {
    render(
      <TabPanel idPrefix="security" tabKey="overview" isActive>
        <p>Panel body</p>
      </TabPanel>,
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('id', tabPanelId('security', 'overview'));
    expect(panel).toHaveAttribute(
      'aria-labelledby',
      tabId('security', 'overview'),
    );
    expect(screen.getByText('Panel body')).toBeInTheDocument();
  });

  it('renders nothing when inactive, so its content never loads', () => {
    render(
      <TabPanel idPrefix="security" tabKey="overview" isActive={false}>
        <p>Panel body</p>
      </TabPanel>,
    );
    expect(screen.queryByRole('tabpanel')).not.toBeInTheDocument();
    expect(screen.queryByText('Panel body')).not.toBeInTheDocument();
  });
});

describe('TabPanel keepMounted', () => {
  function Harness({ keepMounted }: { keepMounted?: boolean }) {
    const [tab, setTab] = useState<'a' | 'b'>('a');
    return (
      <>
        <Tabs
          tabs={[
            { key: 'a' as const, label: 'A' },
            { key: 'b' as const, label: 'B' },
          ]}
          value={tab}
          onChange={setTab}
          idPrefix="h"
          ariaLabel="Sections"
        />
        <TabPanel idPrefix="h" tabKey="a" isActive={tab === 'a'}>
          Panel A
        </TabPanel>
        <TabPanel
          idPrefix="h"
          tabKey="b"
          isActive={tab === 'b'}
          keepMounted={keepMounted}
        >
          Panel B
        </TabPanel>
      </>
    );
  }

  it('does not mount a panel that has never been selected', () => {
    // The point of lazy panels: no requests for a tab nobody opened.
    render(<Harness keepMounted />);
    expect(screen.queryByText('Panel B')).not.toBeInTheDocument();
  });

  it('keeps a visited panel in the DOM, hidden, once it has been left', () => {
    render(<Harness keepMounted />);
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByText('Panel B')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: 'A' }));
    // Still mounted -- so its fetched rows survive and coming back does not
    // replay the loading state, which read as the page reloading.
    // Both panels are in the DOM now, so this addresses B by its own id.
    const panelB = document.getElementById(tabPanelId('h', 'b'));
    expect(panelB).toBeInTheDocument();
    expect(panelB).toHaveAttribute('hidden');
    expect(screen.getByText('Panel A')).toBeVisible();
  });

  it('unmounts a panel that did not ask to be kept', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    expect(screen.getByText('Panel B')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'A' }));
    expect(screen.queryByText('Panel B')).not.toBeInTheDocument();
  });

  it('hides the inactive panel from assistive tech and the tab order', () => {
    render(<Harness keepMounted />);
    fireEvent.click(screen.getByRole('tab', { name: 'B' }));
    fireEvent.click(screen.getByRole('tab', { name: 'A' }));
    // `hidden` does both, where a visually-hidden class would leave a focusable
    // panel announced to a screen reader.
    expect(screen.getAllByRole('tabpanel')).toHaveLength(1);
  });
});
