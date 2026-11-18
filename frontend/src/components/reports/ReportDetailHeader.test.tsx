import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { ReportDetailHeader } from './ReportDetailHeader';
import { stubCollapsingTitle } from '@/test/collapsing-title';
import { customReportsApi } from '@/lib/custom-reports';
import { investmentReportsApi } from '@/lib/investment-reports';

const push = vi.fn();

// Overrides the global mock in `test/setup.ts` with a router whose `push` this
// file can assert on.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/reports/tax-summary',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/lib/custom-reports', () => ({
  customReportsApi: { getAll: vi.fn() },
}));

vi.mock('@/lib/investment-reports', () => ({
  investmentReportsApi: { getAll: vi.fn() },
}));

async function renderHeader(reportId = 'tax-summary') {
  await act(async () => {
    render(
      <ReportDetailHeader
        reportId={reportId}
        title="Tax Summary"
        subtitle="Deductible categories for the year"
        actions={<button type="button">Edit</button>}
      />,
    );
  });
}

describe('ReportDetailHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(customReportsApi.getAll).mockResolvedValue([]);
    vi.mocked(investmentReportsApi.getAll).mockResolvedValue([]);
  });

  it('links back to the report list above the title', async () => {
    await renderHeader();
    const back = screen.getByRole('link', { name: 'Back to Reports' });
    expect(back).toHaveAttribute('href', '/reports');
    // Above the title, not among the actions -- the way back is not an action
    // on this report.
    expect(
      back.compareDocumentPosition(screen.getByRole('heading', { level: 1 })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('lets a long title wrap on mobile instead of truncating it', async () => {
    await renderHeader();
    const heading = screen.getByRole('heading', { level: 1 });
    // The identity wraps unclamped on a phone; the ellipsis is desktop-only.
    expect(heading.className).toContain('break-words');
    expect(heading.className).not.toMatch(/(^|\s)truncate(\s|$)/);
    expect(heading.className).toContain('sm:truncate');
  });

  it('renders the title, subtitle and actions', async () => {
    await renderHeader();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tax Summary');
    expect(
      screen.getByText('Deductible categories for the year'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('navigates to the report picked from the caret beside the title', async () => {
    await renderHeader();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Switch to another report' }),
      );
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Savings Rate/ }));
    expect(push).toHaveBeenCalledWith('/reports/savings-rate');
  });

  it('routes a custom report through its own path', async () => {
    vi.mocked(customReportsApi.getAll).mockResolvedValue([
      { id: 'c1', name: 'Groceries Deep Dive' },
    ] as unknown as Awaited<ReturnType<typeof customReportsApi.getAll>>);
    await renderHeader();
    await act(async () => {
      fireEvent.click(
        screen.getByRole('button', { name: 'Switch to another report' }),
      );
    });
    fireEvent.click(screen.getByRole('menuitem', { name: /Groceries Deep Dive/ }));
    expect(push).toHaveBeenCalledWith('/reports/custom/c1');
  });

  it("hands the app header \"Reports\" with this report's name and the same report caret", async () => {
    const title = stubCollapsingTitle();
    try {
      await renderHeader();
      title.collapse();
      expect(title.current()).toMatchObject({
        title: 'Reports',
        context: 'Tax Summary',
        switcher: { currentId: 'tax-summary', showCurrent: true },
      });
      act(() => title.current()?.switcher?.onSelect('net-worth'));
      expect(push).toHaveBeenCalledWith('/reports/net-worth');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
