import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@/test/render';
import { setAuthenticatedState } from '@/test/mocks/stores';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';
import AiPage from './page';

// The chat is a heavy component with its own store and streaming; this page is
// only the header and the shell around it.
vi.mock('@/components/ai/ChatInterface', () => ({
  ChatInterface: () => <div data-testid="chat-interface">ChatInterface</div>,
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({ force2fa: false, demo: false }),
  },
}));

const VIEWER_ID = 'user-1';

function signIn(id: string | null) {
  useAuthStore.setState({
    user: id ? ({ id, email: 'reader@monize.test' } as User) : null,
    isAuthenticated: id !== null,
  });
}

async function renderPage() {
  await act(async () => {
    render(<AiPage />);
  });
}

describe('AiPage', () => {
  beforeEach(() => {
    setAuthenticatedState();
    signIn(VIEWER_ID);
  });

  afterEach(() => {
    cleanup();
    signIn(null);
    vi.clearAllMocks();
  });

  it('renders the page header', async () => {
    await renderPage();

    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(
      screen.getByText('Ask questions about your finances in natural language'),
    ).toBeInTheDocument();
  });

  it('renders the ChatInterface component', async () => {
    await renderPage();

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
