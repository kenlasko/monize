import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@/test/render';
import { setAuthenticatedState } from '@/test/mocks/stores';
import { useAuthStore } from '@/store/authStore';
import type { User } from '@/types/auth';
import { peekChatHandoff, stageChatHandoff } from '@/lib/ai-chat-handoff';
import AiPage from './page';

// The page reads `?share=` for the Web Share Target hand-off, so the search
// params have to be settable the way the review screen's own test sets them.
const searchParams = { value: new URLSearchParams() };
const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  back: vi.fn(),
  prefetch: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => routerMock,
  usePathname: () => '/ai',
  useSearchParams: () => searchParams.value,
}));

const mocks = vi.hoisted(() => ({
  readSharedBundle: vi.fn(),
  discardSharedBundle: vi.fn(),
}));

vi.mock('@/lib/share-inbox', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/share-inbox')>()),
  readSharedBundle: mocks.readSharedBundle,
  discardSharedBundle: mocks.discardSharedBundle,
}));

// The chat is a heavy component with its own store and streaming; this page's
// contract is only which files it hands over, and when the stash may be let go.
const chatInterface = vi.hoisted(() => vi.fn());
vi.mock('@/components/ai/ChatInterface', () => ({
  ChatInterface: (props: {
    initialFiles?: File[];
    onInitialFilesStaged?: () => void;
    initialDraft?: string;
  }) => {
    chatInterface(props);
    return <div data-testid="chat-interface">ChatInterface</div>;
  },
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

function bundle(files: File[], expired = false) {
  return {
    index: { id: 'bundle-1', createdAt: Date.now(), files: [] },
    items: [],
    files,
    expired,
  };
}

async function renderPage() {
  await act(async () => {
    render(<AiPage />);
  });
}

function lastChatProps() {
  return chatInterface.mock.calls[chatInterface.mock.calls.length - 1][0];
}

describe('AiPage', () => {
  beforeEach(() => {
    setAuthenticatedState();
    signIn(VIEWER_ID);
    searchParams.value = new URLSearchParams();
    mocks.readSharedBundle.mockResolvedValue(null);
    mocks.discardSharedBundle.mockResolvedValue(undefined);
    chatInterface.mockClear();
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

  it('reads nothing from the stash when no share was handed over', async () => {
    await renderPage();

    expect(mocks.readSharedBundle).not.toHaveBeenCalled();
    expect(lastChatProps().initialFiles).toBeUndefined();
  });

  describe('the in-app hand-off (the receipts page)', () => {
    const files = () => [new File(['From: a'], 'order-email-2026-09-10.txt', { type: 'text/plain' })];

    it('stages the parked file and the drafted message on the composer, and sends nothing', async () => {
      const handed = files();
      const id = stageChatHandoff({ files: handed, draft: 'Recognize the products' });
      searchParams.value = new URLSearchParams(`handoff=${id}`);

      await renderPage();

      expect(lastChatProps().initialFiles).toEqual(handed);
      expect(lastChatProps().initialDraft).toBe('Recognize the products');
      expect(mocks.readSharedBundle).not.toHaveBeenCalled();
      // Still parked until the composer reports it holds the files.
      expect(peekChatHandoff(id)).not.toBeNull();
    });

    it('discards the parked entry once the chat reports the files are staged', async () => {
      const id = stageChatHandoff({ files: files(), draft: 'x' });
      searchParams.value = new URLSearchParams(`handoff=${id}`);
      await renderPage();

      await act(async () => {
        lastChatProps().onInitialFilesStaged?.();
      });

      expect(peekChatHandoff(id)).toBeNull();
    });

    it('stages nothing for an unknown or malformed id', async () => {
      searchParams.value = new URLSearchParams('handoff=not-an-id');
      await renderPage();
      expect(lastChatProps().initialFiles).toBeUndefined();
      expect(lastChatProps().initialDraft).toBeUndefined();

      searchParams.value = new URLSearchParams(`handoff=${crypto.randomUUID()}`);
      await renderPage();
      expect(lastChatProps().initialFiles).toBeUndefined();
    });
  });

  describe('the Web Share Target hand-off', () => {
    beforeEach(() => {
      searchParams.value = new URLSearchParams('share=bundle-1');
    });

    it('stages the shared files on the composer, and asks nothing on arrival', async () => {
      const files = [new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })];
      mocks.readSharedBundle.mockResolvedValue(bundle(files));

      await renderPage();

      await waitFor(() => expect(lastChatProps().initialFiles).toEqual(files));
      expect(mocks.readSharedBundle).toHaveBeenCalledWith('bundle-1', VIEWER_ID);
      // Staged, never sent: the bundle is still in the stash until the chat
      // reports it has read the bytes.
      expect(mocks.discardSharedBundle).not.toHaveBeenCalled();
    });

    it('discards the bundle only once the chat reports the files are staged', async () => {
      mocks.readSharedBundle.mockResolvedValue(
        bundle([new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })]),
      );

      await renderPage();

      await waitFor(() => expect(lastChatProps().initialFiles).toBeDefined());
      expect(mocks.discardSharedBundle).not.toHaveBeenCalled();

      await act(async () => {
        lastChatProps().onInitialFilesStaged?.();
      });

      await waitFor(() =>
        expect(mocks.discardSharedBundle).toHaveBeenCalledWith('bundle-1'),
      );
    });

    // A bundle belongs to one account, so nothing is read until the store says
    // who is reading -- the same rule the review screen follows.
    it('reads nothing until the reader is known', async () => {
      signIn(null);
      mocks.readSharedBundle.mockResolvedValue(
        bundle([new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })]),
      );

      await renderPage();

      expect(mocks.readSharedBundle).not.toHaveBeenCalled();

      await act(async () => {
        signIn(VIEWER_ID);
      });

      await waitFor(() =>
        expect(mocks.readSharedBundle).toHaveBeenCalledWith('bundle-1', VIEWER_ID),
      );
    });

    it('stages nothing from an expired bundle, and keeps the chat usable', async () => {
      mocks.readSharedBundle.mockResolvedValue(
        bundle([new File(['x'], 'receipt.jpg', { type: 'image/jpeg' })], true),
      );

      await renderPage();

      await waitFor(() => expect(mocks.readSharedBundle).toHaveBeenCalled());
      expect(lastChatProps().initialFiles).toBeUndefined();
      expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    });

    it('leaves the chat usable when the stash read fails', async () => {
      mocks.readSharedBundle.mockRejectedValue(new Error('cache unavailable'));

      await renderPage();

      await waitFor(() => expect(mocks.readSharedBundle).toHaveBeenCalled());
      expect(lastChatProps().initialFiles).toBeUndefined();
      expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    });
  });
});
