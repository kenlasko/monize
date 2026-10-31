import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { ListTopToolbar } from './ListTopToolbar';
import { useDensityStore } from '@/store/densityStore';

function renderToolbar(ui: React.ReactElement) {
  return render(ui);
}

const PAGING = {
  currentPage: 2,
  totalPages: 4,
  totalItems: 90,
  pageSize: 25,
};

describe('ListTopToolbar', () => {
  beforeEach(() => {
    useDensityStore.setState({ densities: { transactions: 'normal' } });
  });

  it('says where in the list the reader is', () => {
    renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={vi.fn()} itemName="transactions" />,
    );

    expect(screen.getByText('26')).toBeInTheDocument();
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('90')).toBeInTheDocument();
  });

  it('pages from the bar', () => {
    const onPageChange = vi.fn();
    renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={onPageChange} />,
    );

    fireEvent.click(screen.getByTitle('Next page'));

    expect(onPageChange).toHaveBeenCalledWith(3);
  });

  it('carries the density toggle whether or not there is a pager', () => {
    const { unmount } = renderToolbar(
      <ListTopToolbar densityView="transactions" {...PAGING} onPageChange={vi.fn()} />,
    );
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
    unmount();

    renderToolbar(<ListTopToolbar densityView="transactions" />);
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
  });

  it('keeps the count on a single page, which is where a filter lands', () => {
    // "Showing 1-7 of 7" is the answer to "did that filter work?", so hiding it
    // exactly when a filter has narrowed the list to one page takes the count
    // away at the moment it is being read.
    renderToolbar(
      <ListTopToolbar
        densityView="transactions"
        currentPage={1}
        totalPages={1}
        totalItems={7}
        pageSize={25}
        onPageChange={vi.fn()}
        itemName="transactions"
      />,
    );

    // The line is assembled from several nodes, so it is matched as text.
    expect(document.body.textContent).toContain('Showing');
    expect(document.body.textContent).toContain('of');
    expect(screen.getAllByText('7').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Next page')).toBeDisabled();
  });

  it('draws no pager when the paging props are not supplied', () => {
    renderToolbar(<ListTopToolbar densityView="transactions" />);

    expect(screen.queryByTitle('Next page')).not.toBeInTheDocument();
  });

  it('puts the list its own buttons beside the toggle', () => {
    renderToolbar(
      <ListTopToolbar
        densityView="transactions"
        {...PAGING}
        onPageChange={vi.fn()}
        actions={<button>Export</button>}
      />,
    );

    expect(screen.getByText('Export')).toBeInTheDocument();
  });

  it('reads count, switch, then the list buttons and the pager', () => {
    // Order is the assertion, not merely "somewhere in the bar": the switch
    // reads with the line saying what the reader is looking at, and export and
    // density sit at the right-hand end in front of the page stepper.
    render(
      <ListTopToolbar
        densityView="transactions"
        {...PAGING}
        onPageChange={vi.fn()}
        actions={<button type="button">Export</button>}
        viewToggle={<button type="button">Switch view</button>}
      />,
    );

    const count = screen.getByText('90');
    const toggle = screen.getByRole('button', { name: 'Switch view' });
    const exportButton = screen.getByRole('button', { name: 'Export' });
    const density = screen.getByTitle('Toggle row density');
    const firstPage = screen.getByTitle('First page');

    expect(count.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(toggle.compareDocumentPosition(exportButton)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(exportButton.compareDocumentPosition(density)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(density.compareDocumentPosition(firstPage)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('keeps the list buttons and the pager in one wrapping row', () => {
    // They were a column that stacked below a fixed width, which put export and
    // density on a line of their own while there was still room for both.
    render(
      <ListTopToolbar
        densityView="transactions"
        {...PAGING}
        onPageChange={vi.fn()}
        actions={<button type="button">Export</button>}
      />,
    );

    const row = screen.getByTitle('Last page').parentElement!.parentElement!;

    expect(row.className).toContain('flex-wrap');
    expect(row.className).not.toContain('flex-col');
    expect(row).toContainElement(screen.getByRole('button', { name: 'Export' }));
  });

  it('keeps the switch with the buttons when there is no pager to sit beside', () => {
    // The empty register draws the bar without paging props, so there is no
    // count line for the switch to ride: it stays in the button group rather
    // than disappearing.
    render(
      <ListTopToolbar
        densityView="transactions"
        viewToggle={<button type="button">Switch view</button>}
      />,
    );

    const density = screen.getByTitle('Toggle row density');
    const toggle = screen.getByRole('button', { name: 'Switch view' });

    expect(density.compareDocumentPosition(toggle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('leaves the bar as it was on a list whose screen offers no calendar', () => {
    render(<ListTopToolbar densityView="transactions" {...PAGING} onPageChange={vi.fn()} />);

    expect(screen.queryByRole('button', { name: 'Switch view' })).not.toBeInTheDocument();
    expect(screen.getByTitle('Toggle row density')).toBeInTheDocument();
  });
  it("supports list actions without inventing a density preference", () => {
    renderToolbar(<ListTopToolbar actions={<button>Export</button>} />);
    expect(screen.getByRole("button", { name: "Export" })).toBeInTheDocument();
    expect(screen.queryByTitle("Toggle row density")).not.toBeInTheDocument();
  });
});
