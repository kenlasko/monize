import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
import { setAuthenticatedState } from '@/test/mocks/stores';
import AiPage from './page';

// Mock the child components to isolate page-level tests
vi.mock('@/components/ai/ChatInterface', () => ({
  ChatInterface: () => <div data-testid="chat-interface">ChatInterface</div>,
}));

vi.mock('@/lib/auth', () => ({
  authApi: {
    getAuthMethods: vi.fn().mockResolvedValue({ force2fa: false, demo: false }),
  },
}));

describe('AiPage', () => {
  it('renders the page header', () => {
    setAuthenticatedState();
    render(<AiPage />);

    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask questions about your finances in natural language',
      ),
    ).toBeInTheDocument();
  });

  it('renders the ChatInterface component', () => {
    setAuthenticatedState();
    render(<AiPage />);

    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
  });
});
