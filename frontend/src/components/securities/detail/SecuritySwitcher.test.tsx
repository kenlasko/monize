import { describe, it, expect, vi } from 'vitest';
import { screen, fireEvent } from '@testing-library/react';
import { render } from '@/test/render';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import { useSecuritySwitcher } from './SecuritySwitcher';
import type { Security } from '@/types/investment';

// One router object, as the real hook returns: the switcher is memoized on it.
const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

/** The caret exactly as the detail header draws it. */
function SecuritySwitcher({
  currentId,
  securities,
}: {
  currentId: string;
  securities: Security[];
}) {
  return <EntitySwitcher {...useSecuritySwitcher(currentId, securities)} />;
}

function security(id: string, symbol: string, name: string): Security {
  return {
    id,
    symbol,
    name,
    securityType: 'ETF',
    exchange: 'XETRA',
    currencyCode: 'EUR',
    description: null,
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
    lastPriceSource: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  };
}

/** More than the filter threshold of 8, so the box appears. */
function manySecurities(count: number): Security[] {
  return Array.from({ length: count }, (_, index) =>
    security(`sec-${index}`, `SYM${index}`, `Security number ${index}`),
  );
}

const two = [
  security('sec-1', 'IUSQ', 'All World'),
  security('sec-2', 'VWCE', 'FTSE All-World'),
];

function open(securities: Security[], currentId = 'sec-1') {
  const onSelect = router.push;
  onSelect.mockClear();
  render(
    <SecuritySwitcher
      currentId={currentId}
      securities={securities}
    />,
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Switch to another security' }),
  );
  return { onSelect };
}

describe('SecuritySwitcher', () => {
  it('does not render when there is nowhere to switch to', () => {
    // The caret would open an empty menu.
    const { container } = render(
      <SecuritySwitcher
        currentId="sec-1"
        securities={[security('sec-1', 'IUSQ', 'All World')]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while the list is still loading', () => {
    const { container } = render(
      <SecuritySwitcher currentId="sec-1" securities={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('leaves the security already on screen out of the menu', () => {
    open(two);
    expect(screen.getByRole('menuitem', { name: /VWCE/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /IUSQ/ })).not.toBeInTheDocument();
  });

  it('leaves inactive securities out of the menu', () => {
    open([...two, { ...security('sec-3', 'OLD', 'Sold Fund'), isActive: false }]);
    expect(screen.getByRole('menuitem', { name: /VWCE/ })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /OLD/ })).not.toBeInTheDocument();
  });

  it('reports the chosen security and closes', () => {
    const { onSelect } = open(two);
    fireEvent.click(screen.getByRole('menuitem', { name: /VWCE/ }));
    expect(onSelect).toHaveBeenCalledWith('/securities/sec-2');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('marks the caret expanded while the menu is open', () => {
    open(two);
    expect(
      screen.getByRole('button', { name: 'Switch to another security' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes again when the caret is clicked a second time', () => {
    open(two);
    fireEvent.click(
      screen.getByRole('button', { name: 'Switch to another security' }),
    );
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  describe('the filter', () => {
    it('stays away for a handful of securities', () => {
      // One more box to skip past is worse than scanning three rows.
      open(two);
      expect(
        screen.queryByLabelText('Filter by symbol or name...'),
      ).not.toBeInTheDocument();
    });

    it('appears once scanning the list is slower than typing', () => {
      open(manySecurities(12));
      expect(
        screen.getByLabelText('Filter by symbol or name...'),
      ).toBeInTheDocument();
    });

    it('matches on symbol and on name', () => {
      open(manySecurities(12));
      const box = screen.getByLabelText('Filter by symbol or name...');

      fireEvent.change(box, { target: { value: 'sym11' } });
      expect(screen.getAllByRole('menuitem')).toHaveLength(1);

      fireEvent.change(box, { target: { value: 'number 7' } });
      expect(screen.getAllByRole('menuitem')).toHaveLength(1);
    });

    it('says so when nothing matches', () => {
      open(manySecurities(12));
      fireEvent.change(screen.getByLabelText('Filter by symbol or name...'), {
        target: { value: 'no such thing' },
      });
      expect(screen.getByText('No securities match')).toBeInTheDocument();
    });

    it('forgets the query when the menu closes', () => {
      open(manySecurities(12));
      const trigger = screen.getByRole('button', {
        name: 'Switch to another security',
      });
      fireEvent.change(screen.getByLabelText('Filter by symbol or name...'), {
        target: { value: 'sym11' },
      });
      fireEvent.click(trigger);
      fireEvent.click(trigger);
      // Reopening onto a stale filter looks like most of the list vanishing.
      expect(screen.getAllByRole('menuitem').length).toBeGreaterThan(1);
    });
  });

  it('closes on Escape and hands focus back to the caret', () => {
    open(two);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Switch to another security' }),
    ).toHaveFocus();
  });

  it('closes on a click outside itself', () => {
    open(two);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
