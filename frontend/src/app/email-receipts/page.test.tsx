import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import EmailReceiptsPage from './page';
import EmailReceiptsLayout from './layout';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('@/lib/email-receipts-api', () => ({
  emailReceiptsApi: {
    receipts: {
      list: vi.fn().mockResolvedValue([]),
      listDomains: vi.fn().mockResolvedValue([]),
      overview: vi.fn().mockResolvedValue({
        mailbox: null,
        emailsByStatus: {},
        processable: 0,
        proposalsToApprove: 0,
        parsers: { approved: 0, draft: 0 },
        domainsWithoutProfile: [],
      }),
    },
    mailbox: { get: vi.fn().mockResolvedValue(null) },
  },
}));
vi.mock('@/lib/payees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payees')>()),
  payeesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@/lib/categories', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/categories')>()),
  categoriesApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

const replace = vi.hoisted(() => vi.fn());
let actingAsUserId: string | null = null;
let search = '';

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ replace, push: vi.fn() }),
  usePathname: () => '/email-receipts',
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock('@/store/authStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ actingAsUserId }),
}));

vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => false }));

describe('EmailReceiptsPage', () => {
  beforeEach(() => {
    search = '';
  });

  it('opens on the Overview of the hub, with its four tabs', async () => {
    await act(async () => {
      render(<EmailReceiptsPage />);
    });
    await act(async () => {});
    expect(screen.getByRole('heading', { level: 1, name: 'Email Receipts' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the Monize documentation for help with this section' })).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/email-receipts',
    );
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overview', 'Mailbox', 'Profiles', 'Emails']);
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { name: 'Get started with email receipts' })).toBeInTheDocument();
  });

  it('renders the receipts on the Emails tab, with a way to the review inbox', async () => {
    search = 'tab=emails';
    await act(async () => {
      render(<EmailReceiptsPage />);
    });
    await act(async () => {});
    expect(screen.getByRole('link', { name: 'Open the AI review inbox' })).toHaveAttribute('href', '/ai-reviews');
    expect(screen.getByText('No emails')).toBeInTheDocument();
  });
});

describe('EmailReceiptsLayout', () => {
  beforeEach(() => {
    replace.mockClear();
    actingAsUserId = null;
  });

  it('renders its children for the owner', () => {
    render(
      <EmailReceiptsLayout>
        <p>receipts</p>
      </EmailReceiptsLayout>,
    );
    expect(screen.getByText('receipts')).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it('sends a delegate to the dashboard and renders nothing', () => {
    actingAsUserId = 'owner-1';
    render(
      <EmailReceiptsLayout>
        <p>receipts</p>
      </EmailReceiptsLayout>,
    );
    expect(screen.queryByText('receipts')).not.toBeInTheDocument();
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });
});
