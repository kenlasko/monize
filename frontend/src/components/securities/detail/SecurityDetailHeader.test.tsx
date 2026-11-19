import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, screen } from '@testing-library/react';
import { render, act } from '@/test/render';
import { stubCollapsingTitle } from '@/test/collapsing-title';
import { SecurityDetailHeader, type SecurityQuote } from './SecurityDetailHeader';
import { usePreferencesStore } from '@/store/preferencesStore';
import type { Security } from '@/types/investment';

// One router object, as the real hook returns, whose `push` this file asserts on.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

function security(overrides: Partial<Security> = {}): Security {
  return {
    id: 'sec-1',
    symbol: 'AAPL',
    name: 'Apple Inc.',
    securityType: 'STOCK',
    exchange: 'NASDAQ',
    currencyCode: 'USD',
    tags: [],
    isActive: true,
    isFavourite: false,
    skipPriceUpdates: false,
    sector: null,
    industry: null,
    sectorWeightings: null,
    countryWeightings: null,
    assetWeightings: null,
    website: null,
    irWebsite: null,
    quoteProvider: 'yahoo',
    msnInstrumentId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function quote(overrides: Partial<SecurityQuote> = {}): SecurityQuote {
  return {
    price: 150,
    priceDate: '2026-07-30',
    quotedAt: null,
    change: 5,
    changePercent: 3.45,
    isCurrent: true,
    ...overrides,
  };
}

function renderHeader(
  securityOverrides: Partial<Security> = {},
  quoteValue: SecurityQuote | null = quote(),
  securities: Security[] = [],
) {
  render(
    <SecurityDetailHeader
      security={security(securityOverrides)}
      quote={quoteValue}
      onBack={vi.fn()}
      onEdit={vi.fn()}
      onToggleFavourite={vi.fn()}
      isFavouritePending={false}
      onRefreshPrice={vi.fn()}
      isRefreshingPrice={false}
      securities={securities}
    />,
  );
}

/** New York session, so the fixtures below can straddle its open and close. */
const NYSE_HOURS = {
  marketTimezone: 'America/New_York',
  marketOpenTime: '09:30:00',
  marketCloseTime: '16:00:00',
};

describe('SecurityDetailHeader', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Thursday 2026-07-30, 14:00 UTC = 10:00 in New York: mid-session.
    vi.setSystemTime(new Date('2026-07-30T14:00:00Z'));
    usePreferencesStore.setState({
      preferences: {
        timezone: 'America/New_York',
        timeFormat: '24h',
        dateFormat: 'YYYY-MM-DD',
      },
      isLoaded: true,
    } as never);
  });

  afterEach(() => {
    // Unmount first. Testing Library's own cleanup is registered at import
    // time, and after-hooks run in reverse registration order, so it lands
    // *after* this one -- leaving the header mounted and subscribed while the
    // store is reset below. Each of its preference reads then re-renders it
    // outside act, which is where this file's act warnings came from.
    cleanup();
    vi.useRealTimers();
    usePreferencesStore.setState({ preferences: null, isLoaded: false } as never);
  });

  describe('when the quote was struck', () => {
    it('names the time, in the timezone the user chose', () => {
      renderHeader({}, quote({ quotedAt: '2026-07-30T17:45:00Z' }));
      // 17:45 UTC is 13:45 in New York, the user's selected zone.
      expect(screen.getByText(/2026-07-30 13:45/)).toBeInTheDocument();
    });

    it('falls back to the date alone when no instant was recorded', () => {
      // Manual entries and rows written before the time was kept have none;
      // inventing one would be worse than saying less.
      renderHeader({}, quote({ quotedAt: null }));
      expect(screen.getByText(/Price at 2026-07-30/)).toBeInTheDocument();
      expect(screen.queryByText(/13:45/)).not.toBeInTheDocument();
    });
  });

  describe('the market state badge', () => {
    it('says the market is open during its session', () => {
      renderHeader(NYSE_HOURS);
      expect(screen.getByText('Market open')).toBeInTheDocument();
    });

    it('says closed outside it', () => {
      // 22:00 UTC is 18:00 in New York, two hours after the close.
      vi.setSystemTime(new Date('2026-07-30T22:00:00Z'));
      renderHeader(NYSE_HOURS);
      expect(screen.getByText('Market closed')).toBeInTheDocument();
    });

    it('says closed at the weekend', () => {
      vi.setSystemTime(new Date('2026-08-01T14:00:00Z'));
      renderHeader(NYSE_HOURS);
      expect(screen.getByText('Market closed')).toBeInTheDocument();
    });

    it('shows no badge at all when the hours are not known', () => {
      // Rather than defaulting to a market and stating it confidently.
      renderHeader();
      expect(screen.queryByText('Market open')).not.toBeInTheDocument();
      expect(screen.queryByText('Market closed')).not.toBeInTheDocument();
    });

    it('spells out the session, and that holidays are not covered', () => {
      renderHeader(NYSE_HOURS);
      expect(screen.getByText('Market open')).toHaveAttribute(
        'title',
        expect.stringContaining('09:30 to 16:00'),
      );
      expect(screen.getByText('Market open')).toHaveAttribute(
        'title',
        expect.stringContaining('holidays'),
      );
    });
  });

  it('hands the app header "Securities" with the name and the same caret, active securities only', async () => {
    const title = stubCollapsingTitle();
    try {
      const other = security({ id: 'sec-2', symbol: 'MSFT', name: 'Microsoft' });
      const sold = security({ id: 'sec-3', symbol: 'OLD', name: 'Sold Fund', isActive: false });
      await act(async () => {
        renderHeader({}, quote(), [security(), other, sold]);
      });
      title.collapse();
      expect(title.current()).toMatchObject({
        title: 'Securities',
        context: 'Apple Inc.',
        switcher: { currentId: 'sec-1', secondaryAlign: 'inline' },
      });
      expect(title.current()?.switcher?.items.map((item) => item.id)).toEqual([
        'sec-1',
        'sec-2',
      ]);
      act(() => title.current()?.switcher?.onSelect('sec-2'));
      expect(router.push).toHaveBeenCalledWith('/securities/sec-2');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('wraps the name while the header is stacked and truncates only once it goes row-wise', async () => {
    const longName =
      'A Very Long Security Name That Would Otherwise Be Truncated Corporation Inc.';
    await act(async () => {
      renderHeader({ name: longName });
    });
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(longName);
    // Split on whitespace for an exact-token match, so a revert to `sm:truncate`
    // (or a bare `truncate`) fails rather than being hidden by a substring hit.
    const tokens = heading.className.split(/\s+/);
    // Wraps unclamped while the header is stacked (below `lg`); the single-line
    // ellipsis applies only once the layout flips to a row at `lg`, matching the
    // outer `lg:flex-row` breakpoint. Truncating from `sm` was the bug: the
    // header is still stacked with room to wrap between 640px and 1023px.
    expect(tokens).toContain('break-words');
    expect(tokens).toContain('lg:truncate');
    expect(tokens).not.toContain('sm:truncate');
    expect(tokens).not.toContain('truncate');
  });

  it('renders nothing about timing when there is no price at all', () => {
    renderHeader(NYSE_HOURS, null);
    expect(screen.getByText('No price recorded yet')).toBeInTheDocument();
    expect(screen.queryByText(/Price at/)).not.toBeInTheDocument();
  });
});
