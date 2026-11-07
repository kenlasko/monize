import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@/test/render';
import { __resetModalStateForTesting } from '@/components/ui/Modal';
import type { HelpPage, HelpSearchAnswer } from '@/lib/help';

const getPage = vi.fn();
const search = vi.fn();
vi.mock('@/lib/help', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/help')>()),
  helpApi: {
    getPage: (slug: string) => getPage(slug),
    getManifest: vi.fn(),
    search: (q: string, options?: unknown) => search(q, options),
  },
}));

import { HELP_SEARCH_DEBOUNCE_MS, HelpSearchDialog } from './HelpSearchDialog';
import { useHelpSearchStore } from '@/store/helpSearchStore';
import { useHelpStore } from '@/store/helpStore';

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

function pageOf(slug: string): HelpPage {
  return {
    slug,
    title: `${slug} title`,
    group: 'Core features',
    markdown: `# ${slug}`,
    toc: [
      { depth: 2, id: 'alerts', heading: 'Alerts' },
      { depth: 2, id: 'rollover', heading: 'Rollover' },
    ],
    onlineUrl: `https://www.monize.net/docs/${slug}`,
    images: {},
  };
}

function answer(overrides: Partial<HelpSearchAnswer> = {}): HelpSearchAnswer {
  return {
    results: [
      {
        page: 'budgets',
        section: 'overview',
        pageTitle: 'Budgets',
        heading: 'Overview',
        excerpt: 'Plan your spending with budgets.',
        score: 9,
      },
    ],
    total: 1,
    ...overrides,
  };
}

async function rest() {
  await new Promise((r) => setTimeout(r, HELP_SEARCH_DEBOUNCE_MS + 50));
}

beforeEach(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = vi.fn();
  __resetModalStateForTesting();
  getPage.mockReset();
  getPage.mockImplementation((slug: string) => Promise.resolve(pageOf(slug)));
  search.mockReset();
  search.mockResolvedValue(answer());
  useHelpStore.setState(useHelpStore.getInitialState(), true);
  useHelpSearchStore.setState(useHelpSearchStore.getInitialState(), true);
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  document.body.style.overflow = '';
});

describe('HelpSearchDialog', () => {
  it('shows the current screen\'s table of contents for an empty query', async () => {
    useHelpStore.getState().setContextPage('budgets');
    await act(async () => {
      render(<HelpSearchDialog />);
    });
    expect(await screen.findByText('Alerts')).toBeInTheDocument();
    expect(screen.getByText('Rollover')).toBeInTheDocument();
    expect(screen.getByText('Help for this screen')).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it('shows nothing extra for an empty query with no screen context', async () => {
    await act(async () => {
      render(<HelpSearchDialog />);
    });
    expect(screen.queryByText('Help for this screen')).not.toBeInTheDocument();
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  it('searches once the typed query rests, boosted by the screen context', async () => {
    useHelpStore.getState().setContextPage('dashboard');
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budgets' } });
    expect(search).not.toHaveBeenCalled();
    await act(rest);

    expect(search).toHaveBeenCalledWith('budgets', { context: 'dashboard', limit: 10 });
    expect(await screen.findByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Budgets')).toBeInTheDocument();
  });

  it('never shows an older answer under a newer query', async () => {
    let resolveFirst!: (value: HelpSearchAnswer) => void;
    search.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'first' } });
    await act(rest);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'second' } });
    search.mockResolvedValueOnce(answer({ results: [], total: 0 }));
    await act(rest);
    expect(await screen.findByText(/No results for/)).toBeInTheDocument();

    await act(async () => {
      resolveFirst(answer());
    });
    expect(screen.getByText(/No results for/)).toBeInTheDocument();
  });

  it('shows an error, never "no results", when the search fails', async () => {
    search.mockRejectedValue(new Error('network down'));
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budgets' } });
    await act(rest);

    expect(await screen.findByRole('alert')).toHaveTextContent('Search failed');
    expect(screen.queryByText(/No results for/)).not.toBeInTheDocument();
  });

  it('says there are no results for a query that finds none', async () => {
    search.mockResolvedValue(answer({ results: [], total: 0 }));
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'wombat' } });
    await act(rest);

    expect(await screen.findByText('No results for “wombat”')).toBeInTheDocument();
  });

  it('highlights the typed terms in the excerpt', async () => {
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budgets' } });
    await act(rest);

    const mark = await screen.findByText('budgets', { selector: 'mark' });
    expect(mark).toBeInTheDocument();
  });

  it('moves the active option with arrow keys and opens it with Enter, closing the dialog', async () => {
    search.mockResolvedValue(
      answer({
        results: [
          {
            page: 'budgets',
            section: 'overview',
            pageTitle: 'Budgets',
            heading: 'Overview',
            excerpt: 'x',
            score: 9,
          },
          {
            page: 'budgets',
            section: 'alerts',
            pageTitle: 'Budgets',
            heading: 'Alerts',
            excerpt: 'y',
            score: 7,
          },
        ],
        total: 2,
      }),
    );
    useHelpSearchStore.getState().openSearch();
    await act(async () => {
      render(<HelpSearchDialog />);
    });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'budgets' } });
    await act(rest);
    await screen.findByText('Overview');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([{ page: 'budgets', section: 'alerts' }]);
    await waitFor(() => expect(useHelpSearchStore.getState().open).toBe(false));
  });

  it('opens a toc entry with Enter when the query is empty', async () => {
    useHelpStore.getState().setContextPage('budgets');
    useHelpSearchStore.getState().openSearch();
    await act(async () => {
      render(<HelpSearchDialog />);
    });
    await screen.findByText('Alerts');

    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Enter' });

    expect(useHelpStore.getState().history).toEqual([{ page: 'budgets', section: 'alerts' }]);
  });

  it('selecting a result with the mouse opens it too', async () => {
    useHelpSearchStore.getState().openSearch();
    await act(async () => {
      render(<HelpSearchDialog />);
    });
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'budgets' } });
    await act(rest);
    const option = await screen.findByRole('option');

    fireEvent.mouseDown(option);

    expect(useHelpStore.getState().history).toEqual([{ page: 'budgets', section: 'overview' }]);
    expect(useHelpSearchStore.getState().open).toBe(false);
  });
});
