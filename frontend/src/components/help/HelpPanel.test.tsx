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
    version: '1.2.3',
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
    expect(store().history).toEqual([{ page: 'budgets', section: 'rollover' }]);
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
