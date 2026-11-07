import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, renderInLocale, screen, fireEvent, waitFor, within } from '@/test/render';
import enHelp from '@/i18n/messages/en/help.json';
import type { HelpPage } from '@/lib/help';

let mockPathname = '/budgets';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

let mockMobile = false;
vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: () => mockMobile,
}));

const getPage = vi.fn();
vi.mock('@/lib/help', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/help')>()),
  helpApi: { getPage: (slug: string) => getPage(slug), getManifest: vi.fn() },
}));

import { HelpPanel } from './HelpPanel';
import { useHelpStore } from '@/store/helpStore';
import { useHelpWidthStore } from '@/store/helpWidthStore';
import {
  HELP_PANEL_DEFAULT_WIDTH,
  HELP_PANEL_KEY_STEP,
  HELP_PANEL_MIN_WIDTH,
  helpPanelMaxWidth,
} from './help-layout';
import { HELP_PANEL_OVERLAY_GUTTER } from './scrollbar-gutter';

function pageOf(slug: string, extra: Partial<HelpPage> = {}): HelpPage {
  return {
    slug,
    title: `${slug} title`,
    group: 'Core features',
    markdown: `# ${slug}\n\nBody of ${slug}.\n\n## Alerts\n\nAlert text.\n\n## Rollover\n\nSee [Reports](reports.md).\n`,
    toc: [
      { depth: 2, id: 'alerts', heading: 'Alerts' },
      { depth: 2, id: 'rollover', heading: 'Rollover' },
    ],
    onlineUrl: `https://www.monize.net/docs/${slug}`,
    images: {},
    ...extra,
  };
}

const store = () => useHelpStore.getState();

async function renderPanel() {
  const utils = render(<HelpPanel />);
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  mockPathname = '/budgets';
  mockMobile = false;
  getPage.mockReset();
  getPage.mockImplementation((slug: string) => Promise.resolve(pageOf(slug)));
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  store().openAt({ page: 'budgets' });
});

afterEach(() => {
  document.body.style.overflow = '';
});

describe('HelpPanel: content', () => {
  it('shows the page for the current target as a complementary region', async () => {
    await renderPanel();
    expect(getPage).toHaveBeenCalledWith('budgets');
    expect(screen.getByRole('complementary', { name: 'Help' })).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 2, name: 'budgets title' })).toBeInTheDocument();
    expect(screen.getByText('Body of budgets.')).toBeInTheDocument();
  });

  it('shows a loading state until the page arrives', async () => {
    let resolve!: (page: HelpPage) => void;
    getPage.mockImplementation(() => new Promise<HelpPage>((r) => (resolve = r)));
    await renderPanel();
    expect(screen.getByRole('status')).toHaveTextContent('Loading help');
    await act(async () => resolve(pageOf('budgets')));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('Body of budgets.')).toBeInTheDocument();
  });

  it('says so when the page does not load, never an empty page, and retries', async () => {
    getPage.mockRejectedValueOnce(new Error('network'));
    await renderPanel();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Help could not be loaded');
    expect(screen.queryByText('Body of budgets.')).not.toBeInTheDocument();
    // The way out is still the website.
    expect(within(alert).getByRole('link', { name: 'Open on monize.net' })).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/budgets',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await act(async () => {});
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Body of budgets.')).toBeInTheDocument();
    expect(getPage).toHaveBeenCalledTimes(2);
  });

  it('links the header to the same section on monize.net', async () => {
    useHelpStore.setState(useHelpStore.getInitialState(), true);
    store().openAt({ page: 'budgets', section: 'alerts' });
    await renderPanel();
    expect(screen.getByRole('link', { name: 'Open on monize.net' })).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/budgets#alerts',
    );
  });

  it('notes the guide is in English under another locale, and not under English', async () => {
    await renderPanel();
    expect(screen.queryByText('This guide is in English.')).not.toBeInTheDocument();

    renderInLocale(<HelpPanel />, { locale: 'de', messages: { help: enHelp } });
    await act(async () => {});
    expect(screen.getByText('This guide is in English.')).toBeInTheDocument();
  });
});

describe('HelpPanel: navigation', () => {
  it('follows an internal link inside the panel and steps back and forward', async () => {
    await renderPanel();
    fireEvent.click(await screen.findByRole('link', { name: 'Reports' }));
    await act(async () => {});
    expect(getPage).toHaveBeenLastCalledWith('reports');
    expect(await screen.findByRole('heading', { level: 2, name: 'reports title' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2, name: 'budgets title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Forward' }));
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 2, name: 'reports title' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('lists the page sections in a collapsible table of contents', async () => {
    await renderPanel();
    await screen.findByText('Body of budgets.');
    const toggle = screen.getByRole('button', { name: 'On this page' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('navigation', { name: 'Sections on this page' })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Rollover' }));
    expect(store().history).toEqual([
      { page: 'budgets' },
      { page: 'budgets', section: 'rollover' },
    ]);
  });

  it('enables Back after a table-of-contents jump and returns to the section it came from', async () => {
    await renderPanel();
    await screen.findByText('Body of budgets.');
    const back = screen.getByRole('button', { name: 'Back' });
    const forward = screen.getByRole('button', { name: 'Forward' });
    expect(back).toBeDisabled();
    expect(forward).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'On this page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alerts' }));
    fireEvent.click(screen.getByRole('button', { name: 'Rollover' }));
    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    expect(store().history[store().cursor]).toEqual({ page: 'budgets', section: 'alerts' });
    expect(back).toBeEnabled();
    expect(forward).toBeEnabled();

    fireEvent.click(back);
    expect(store().history[store().cursor]).toEqual({ page: 'budgets' });
    expect(back).toBeDisabled();

    fireEvent.click(forward);
    expect(store().history[store().cursor]).toEqual({ page: 'budgets', section: 'alerts' });
  });

  it('pushes history when another help icon opens a different section while the panel is open', async () => {
    await renderPanel();
    await screen.findByText('Body of budgets.');
    act(() => store().openAt({ page: 'budgets', section: 'alerts' }));
    expect(screen.getByRole('button', { name: 'Back' })).toBeEnabled();
    act(() => store().openAt({ page: 'reports', section: 'budget-reports' }));
    await act(async () => {});
    expect(await screen.findByRole('heading', { level: 2, name: 'reports title' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    await act(async () => {});
    expect(store().history[store().cursor]).toEqual({ page: 'budgets', section: 'alerts' });
  });
});

describe('HelpPanel: scrolling to a section', () => {
  let scrollIntoView: ReturnType<typeof vi.fn>;
  const rect = (top: number) => ({ top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;

  beforeEach(() => {
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.id === 'alerts') return rect(500);
      if (this.getAttribute('aria-label') === 'budgets title') return rect(100);
      return rect(0);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('moves the panel scroller, not the page, and focuses the heading', async () => {
    useHelpStore.setState(useHelpStore.getInitialState(), true);
    store().openAt({ page: 'budgets', section: 'alerts' });
    await renderPanel();

    const scroller = screen.getByLabelText('budgets title', { selector: 'div' });
    await waitFor(() => expect(scroller.scrollTop).toBe(500 - 100 - 8));
    expect(screen.getByRole('heading', { level: 2, name: 'Alerts' })).toHaveFocus();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('goes back to the top for a page opened without a section', async () => {
    await renderPanel();
    const scroller = screen.getByLabelText('budgets title', { selector: 'div' });
    scroller.scrollTop = 300;
    await act(async () => store().navigate({ page: 'budgets' }));
    expect(scroller.scrollTop).toBe(0);
    expect(screen.getByRole('heading', { level: 2, name: 'budgets title' })).toHaveFocus();
  });

  it('never calls scrollIntoView in its source', () => {
    const source = readFileSync(join(__dirname, 'HelpPanel.tsx'), 'utf8');
    expect(source).not.toMatch(/scrollIntoView\s*\(/);
  });
});

describe('HelpPanel: pin, route changes, Escape', () => {
  it('closes on a route change when unpinned', async () => {
    const { rerender } = await renderPanel();
    mockPathname = '/reports';
    rerender(<HelpPanel />);
    expect(store().open).toBe(false);
  });

  it('stays open, on the same page, across route changes when pinned', async () => {
    const { rerender } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Pin the help panel/ }));
    expect(screen.getByRole('button', { name: 'Unpin the help panel' })).toHaveAttribute('aria-pressed', 'true');

    mockPathname = '/reports';
    rerender(<HelpPanel />);
    mockPathname = '/tags';
    rerender(<HelpPanel />);
    expect(store().open).toBe(true);
    expect(store().history).toEqual([{ page: 'budgets' }]);
  });

  it('does not treat opening as a route change', async () => {
    await renderPanel();
    expect(store().open).toBe(true);
  });

  it('closes with Escape', async () => {
    await renderPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store().open).toBe(false);
  });

  it('steps from expanded to docked with the first Escape, then closes', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Expand the help panel' }));
    expect(store().expanded).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Help' })).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store().expanded).toBe(false);
    expect(store().open).toBe(true);
    expect(screen.getByRole('complementary')).toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store().open).toBe(false);
  });

  it('leaves Escape to a dialog that has focus on top of the panel', async () => {
    await renderPanel();
    const other = document.createElement('div');
    other.setAttribute('role', 'dialog');
    other.innerHTML = '<button id="in-dialog">Inside</button>';
    document.body.appendChild(other);
    other.querySelector('button')!.focus();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store().open).toBe(true);
    other.remove();
  });

  describe('docked: Escape belongs to the panel only while focus is in it', () => {
    it('ignores Escape pressed while focus is elsewhere on the page', async () => {
      const field = document.createElement('input');
      document.body.appendChild(field);
      await renderPanel();
      field.focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(store().open).toBe(true);
      field.remove();
    });

    it('closes on Escape while focus is inside the panel', async () => {
      await renderPanel();
      screen.getByRole('button', { name: /Pin the help panel/ }).focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(store().open).toBe(false);
    });
  });

  describe('modal: Escape is global', () => {
    it('closes on a phone even when focus is outside the panel', async () => {
      mockMobile = true;
      const field = document.createElement('input');
      document.body.appendChild(field);
      await renderPanel();
      field.focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(store().open).toBe(false);
      field.remove();
    });

    it('steps down from expanded even when focus is outside the panel', async () => {
      const field = document.createElement('input');
      document.body.appendChild(field);
      await renderPanel();
      fireEvent.click(screen.getByRole('button', { name: 'Expand the help panel' }));
      field.focus();
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(store().expanded).toBe(false);
      expect(store().open).toBe(true);
      field.remove();
    });
  });

  it('closes from its close button and hands focus back to the opener', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { unmount } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(store().open).toBe(false);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('HelpPanel: focus on open', () => {
  const opener = () => {
    const el = document.createElement('button');
    el.textContent = 'opener';
    document.body.appendChild(el);
    el.focus();
    return el;
  };

  it('moves focus to the title at once, before the page has loaded', async () => {
    getPage.mockImplementation(() => new Promise<HelpPage>(() => {}));
    const el = opener();
    await renderPanel();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Help' })).toHaveFocus();
    el.remove();
  });

  it('moves focus to the title when the page cannot be loaded', async () => {
    getPage.mockRejectedValue(new Error('network'));
    const el = opener();
    await renderPanel();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Help' })).toHaveFocus();
    el.remove();
  });

  it('on a phone, puts focus inside the dialog while loading and on error', async () => {
    mockMobile = true;
    getPage.mockImplementation(() => new Promise<HelpPage>(() => {}));
    const el = opener();
    const loading = await renderPanel();
    expect(screen.getByRole('dialog', { name: 'Help' })).toContainElement(document.activeElement as HTMLElement);
    loading.unmount();

    getPage.mockReset();
    getPage.mockRejectedValue(new Error('network'));
    el.focus();
    await renderPanel();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Help' })).toContainElement(document.activeElement as HTMLElement);
    el.remove();
  });
});

describe('HelpPanel: giving focus back', () => {
  const button = (label: string) => {
    const el = document.createElement('button');
    el.textContent = label;
    document.body.appendChild(el);
    return el;
  };

  it('returns focus to the opener when the reader closes the panel with Escape', async () => {
    const opener = button('opener');
    opener.focus();
    const { unmount } = await renderPanel();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(store().open).toBe(false);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('returns focus to the opener when the scrim closes the panel on a phone', async () => {
    mockMobile = true;
    const opener = button('opener');
    opener.focus();
    const { container, unmount } = await renderPanel();
    fireEvent.click(container.querySelector('.bg-black\\/30')!);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });

  it('leaves focus where the reader put it when something else closes the panel', async () => {
    // The assistant launcher closes help and is then what the reader is using.
    const opener = button('opener');
    const launcher = button('assistant launcher');
    opener.focus();
    const { unmount } = await renderPanel();
    expect(screen.getByRole('heading', { level: 2, name: /title|Help/ })).toHaveFocus();

    launcher.focus();
    act(() => store().close());
    unmount();
    expect(launcher).toHaveFocus();
    opener.remove();
    launcher.remove();
  });

  it('leaves focus on the page when a route change closes the panel from outside it', async () => {
    const opener = button('opener');
    const field = button('page control');
    opener.focus();
    const { rerender, unmount } = await renderPanel();
    field.focus();
    mockPathname = '/reports';
    rerender(<HelpPanel />);
    expect(store().open).toBe(false);
    unmount();
    expect(field).toHaveFocus();
    opener.remove();
    field.remove();
  });

  it('returns focus to the opener when focus was still inside the panel at close', async () => {
    const opener = button('opener');
    opener.focus();
    const { rerender, unmount } = await renderPanel();
    mockPathname = '/reports';
    rerender(<HelpPanel />);
    expect(store().open).toBe(false);
    unmount();
    expect(opener).toHaveFocus();
    opener.remove();
  });
});

describe('HelpPanel: phone', () => {
  beforeEach(() => {
    mockMobile = true;
  });

  it('is a dialog over a scrim, and the scrim closes it', async () => {
    const { container } = await renderPanel();
    expect(screen.getByRole('dialog', { name: 'Help' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.click(container.querySelector('.bg-black\\/30')!);
    expect(store().open).toBe(false);
  });

  it('keeps Tab inside the dialog', async () => {
    await renderPanel();
    await screen.findByText('Body of budgets.');

    // Tab from the last control wraps to the first enabled one (Back is disabled here).
    const focusable = Array.from(
      screen.getByRole('dialog').querySelectorAll<HTMLElement>('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])'),
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(focusable[0]).toHaveFocus();

    focusable[0].focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
  });
});

describe('HelpPanel: width', () => {
  const VAR = '--help-panel-width';
  const root = document.documentElement;
  /** The width every consumer reads: the panel, the shell's padding, the launcher. */
  const widthVar = () => root.style.getPropertyValue(VAR);
  const panel = () => screen.getByRole('complementary', { name: 'Help' }) as HTMLElement;
  const scroller = () => screen.getByLabelText('budgets title') as HTMLElement;
  const maxHere = helpPanelMaxWidth(window.innerWidth);

  beforeEach(() => {
    useHelpWidthStore.setState({ width: HELP_PANEL_DEFAULT_WIDTH });
    window.localStorage.clear();
  });

  it('opens at the default width, publishes it, and follows the stored width', async () => {
    await renderPanel();
    expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH}px`);
    expect(panel().getAttribute('style')).toContain(`width: var(${VAR})`);
    act(() => useHelpWidthStore.getState().setWidth(640));
    expect(widthVar()).toBe('640px');
  });

  it('takes the variable away when it closes, and when it stops being docked', async () => {
    const { unmount } = await renderPanel();
    expect(widthVar()).not.toBe('');
    act(() => store().setExpanded(true));
    expect(widthVar()).toBe('');
    act(() => store().setExpanded(false));
    expect(widthVar()).not.toBe('');
    unmount();
    expect(widthVar()).toBe('');
  });

  it('exposes a vertical separator carrying the width, its bounds and the panel it resizes', async () => {
    await renderPanel();
    const handle = screen.getByRole('separator', { name: 'Resize the help panel' });
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', String(HELP_PANEL_DEFAULT_WIDTH));
    expect(handle).toHaveAttribute('aria-valuetext', `${HELP_PANEL_DEFAULT_WIDTH} pixels`);
    expect(handle).toHaveAttribute('aria-valuemin', String(HELP_PANEL_MIN_WIDTH));
    expect(handle).toHaveAttribute('aria-valuemax', String(maxHere));
    expect(handle).toHaveAttribute('aria-controls', panel().id);
    expect(panel().id).not.toBe('');
    expect(handle).toHaveAttribute('tabindex', '0');
    // A visible focus ring, not only a background change on an 8px strip.
    expect(handle.className).toContain('focus-visible:ring-2');
  });

  it('has no handle on a phone, where help is a bottom sheet, or when expanded', async () => {
    mockMobile = true;
    const { unmount } = await renderPanel();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
    expect((screen.getByRole('dialog', { name: 'Help' }) as HTMLElement).style.width).toBe('');
    expect(widthVar()).toBe('');
    unmount();

    mockMobile = false;
    act(() => store().setExpanded(true));
    await renderPanel();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();
  });

  it('steps with the arrows (Left widens) and jumps with Home and End, committing each', async () => {
    await renderPanel();
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH + HELP_PANEL_KEY_STEP}px`);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH - HELP_PANEL_KEY_STEP}px`);
    expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH - HELP_PANEL_KEY_STEP);
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(widthVar()).toBe(`${HELP_PANEL_MIN_WIDTH}px`);
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(widthVar()).toBe(`${HELP_PANEL_MIN_WIDTH}px`);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(widthVar()).toBe(`${maxHere}px`);
    expect(handle).toHaveAttribute('aria-valuenow', String(maxHere));
    expect(handle).toHaveAttribute('aria-valuetext', `${maxHere} pixels`);
  });

  it('leaves other keys to the page', async () => {
    await renderPanel();
    const handle = screen.getByRole('separator');
    const event = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    handle.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('keeps the page 640px wide beside the panel on a wide screen', async () => {
    const original = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    try {
      await renderPanel();
      const handle = screen.getByRole('separator');
      expect(handle).toHaveAttribute('aria-valuemax', '640');
      fireEvent.keyDown(handle, { key: 'End' });
      expect(widthVar()).toBe('640px');

      // Narrower than xl the panel overlays the page, so 70% applies.
      act(() => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
        window.dispatchEvent(new Event('resize'));
      });
      expect(handle).toHaveAttribute('aria-valuemax', String(helpPanelMaxWidth(1200)));
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: original });
    }
  });

  describe('dragging', () => {
    const setCapture = vi.fn();
    let frames: FrameRequestCallback[];
    const flushFrame = () => act(() => frames.splice(0).forEach((cb) => cb(0)));
    let setItem: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      setCapture.mockReset();
      Element.prototype.setPointerCapture = setCapture as unknown as typeof Element.prototype.setPointerCapture;
      frames = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => frames.push(cb));
      vi.stubGlobal('cancelAnimationFrame', () => {
        frames = [];
      });
      setItem = vi.spyOn(window.localStorage, 'setItem');
    });
    afterEach(() => {
      setItem.mockRestore();
      vi.unstubAllGlobals();
    });

    it('captures the pointer and previews the width from where the drag began, once a frame', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 7, button: 0, clientX: 600 });
      expect(setCapture).toHaveBeenCalledWith(7);

      // Left by 80px: 80px wider. Measured from the start, not from the last move.
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 540 });
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 520 });
      expect(frames).toHaveLength(1);
      // Nothing has moved until the frame.
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH}px`);
      flushFrame();
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH + 80}px`);
      expect(handle).toHaveAttribute('aria-valuenow', String(HELP_PANEL_DEFAULT_WIDTH + 80));

      // Right of where it began: narrower, down to the minimum and no further.
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 900 });
      flushFrame();
      expect(widthVar()).toBe(`${HELP_PANEL_MIN_WIDTH}px`);

      fireEvent.pointerUp(handle, { pointerId: 7 });
      fireEvent.pointerMove(handle, { pointerId: 7, clientX: 100 });
      expect(frames).toHaveLength(0);
      expect(widthVar()).toBe(`${HELP_PANEL_MIN_WIDTH}px`);
    });

    it('writes nothing to storage and stores nothing while the pointer moves, then commits once on release', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      setItem.mockClear();
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      for (const x of [590, 570, 550, 530, 500]) {
        fireEvent.pointerMove(handle, { pointerId: 1, clientX: x });
        flushFrame();
      }
      expect(setItem).not.toHaveBeenCalled();
      expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH);
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH + 100}px`);

      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(setItem).toHaveBeenCalledTimes(1);
      expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH + 100);
      expect(handle).toHaveAttribute('aria-valuenow', String(HELP_PANEL_DEFAULT_WIDTH + 100));
    });

    it('commits the last move even when the frame has not run before the release', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH + 40);
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH + 40}px`);
    });

    it('does not write storage for a drag that ends where it began', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      setItem.mockClear();
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 540 });
      flushFrame();
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 600 });
      fireEvent.pointerUp(handle, { pointerId: 1 });
      expect(setItem).not.toHaveBeenCalled();
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH}px`);
    });

    it('stops at the maximum for the window', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: -5000 });
      flushFrame();
      expect(widthVar()).toBe(`${maxHere}px`);
    });

    it('ignores a move with no press, and a press of another button', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
      fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
      expect(setCapture).not.toHaveBeenCalled();
      expect(frames).toHaveLength(0);
      expect(widthVar()).toBe(`${HELP_PANEL_DEFAULT_WIDTH}px`);
    });

    it('commits and stops following the pointer when capture is lost', async () => {
      await renderPanel();
      const handle = screen.getByRole('separator');
      fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 600 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 560 });
      fireEvent.lostPointerCapture(handle, { pointerId: 1 });
      fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 });
      expect(useHelpWidthStore.getState().width).toBe(HELP_PANEL_DEFAULT_WIDTH + 40);
      expect(frames).toHaveLength(0);
    });
  });

  it('keeps the scroller short of the edge where scrollbars overlay, so its scrollbar is not under the page one', async () => {
    // jsdom reports no scrollbar width: the overlay case.
    await renderPanel();
    expect(scroller().style.marginRight).toBe(`${HELP_PANEL_OVERLAY_GUTTER}px`);
  });

  it('gives the scroller no gutter where scrollbars are classic, which already end where the page one begins', async () => {
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(115);
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    await renderPanel();
    expect(scroller().style.marginRight).toBe('');
    offset.mockRestore();
    client.mockRestore();
  });

  it('asks the browser about its scrollbars each time the panel mounts, not once per page load', async () => {
    const offset = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
    const client = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get');
    offset.mockReturnValue(115);
    client.mockReturnValue(100);
    const first = await renderPanel();
    expect(scroller().style.marginRight).toBe('');
    first.unmount();

    // The system switched to overlay scrollbars between the two openings.
    offset.mockReturnValue(100);
    await renderPanel();
    expect(scroller().style.marginRight).toBe(`${HELP_PANEL_OVERLAY_GUTTER}px`);
    offset.mockRestore();
    client.mockRestore();
  });

  it('gives the scroller no gutter when expanded, which hides the page scrollbar', async () => {
    act(() => store().setExpanded(true));
    await renderPanel();
    expect(scroller().style.marginRight).toBe('');
  });
});
