import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@/test/render';
import EmailReceiptsSettingsPage from './page';

vi.mock('@/components/auth/ProtectedRoute', () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/email-receipts/MailboxSection', () => ({
  MailboxSection: () => <div data-testid="mailbox-section" />,
}));
vi.mock('@/components/email-receipts/ParsersSection', () => ({
  ParsersSection: () => <div data-testid="parsers-section" />,
}));

let demoMode = false;
vi.mock('@/hooks/useDemoMode', () => ({ useDemoMode: () => demoMode }));

async function renderPage() {
  await act(async () => {
    render(<EmailReceiptsSettingsPage />);
  });
}

describe('EmailReceiptsSettingsPage', () => {
  beforeEach(() => {
    demoMode = false;
  });

  it('shows the mailbox and the parsers under the page heading', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Email Receipts' })).toBeInTheDocument();
    expect(screen.getByTestId('mailbox-section')).toBeInTheDocument();
    expect(screen.getByTestId('parsers-section')).toBeInTheDocument();
  });

  it('links back to Settings and on to the stored emails', async () => {
    await renderPage();
    expect(screen.getByRole('link', { name: /Back to Settings/ })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('link', { name: 'Open the stored emails' })).toHaveAttribute('href', '/email-receipts');
  });

  it('gives the demo account the explanation and none of the controls', async () => {
    demoMode = true;
    await renderPage();
    expect(screen.getByText('Restricted in Demo Mode')).toBeInTheDocument();
    expect(screen.queryByTestId('mailbox-section')).not.toBeInTheDocument();
    expect(screen.queryByTestId('parsers-section')).not.toBeInTheDocument();
  });
});
