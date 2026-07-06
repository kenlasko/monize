import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { ProviderConfigForm } from './ProviderConfigForm';

const mockGetRelayStatus = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    testDraft: vi.fn(),
    createConfig: vi.fn(),
    updateConfig: vi.fn(),
    getRelayStatus: () => mockGetRelayStatus(),
  },
}));

vi.mock('@/components/ui/Modal', () => ({
  Modal: ({ children, isOpen }: any) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

describe('ProviderConfigForm — MCP Relay provider type', () => {
  const noop = async () => undefined;

  beforeEach(() => {
    mockGetRelayStatus.mockReset();
    mockGetRelayStatus.mockResolvedValue({ state: 'listening', queued: 0 });
  });

  async function selectRelay() {
    await act(async () => {
      render(
        <ProviderConfigForm isOpen onClose={() => {}} onSubmit={noop} />,
      );
    });
    // The provider <select> is the first combobox in the add form.
    const select = screen.getAllByRole('combobox')[0];
    await act(async () => {
      fireEvent.change(select, { target: { value: 'mcp_relay' } });
    });
  }

  it('swaps LLM fields for the connect instructions and live status', async () => {
    await selectRelay();

    // Connect instructions (literal command + loop prompt) are shown.
    expect(
      screen.getByText(/claude mcp add --transport http monize/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Loop forever: call get_next_prompt/),
    ).toBeInTheDocument();

    // The anthropic model suggestion chip is gone once relay is selected.
    expect(
      screen.queryByText('claude-sonnet-4-20250514'),
    ).not.toBeInTheDocument();

    // Live status reflects the polled relay state.
    await waitFor(() =>
      expect(screen.getByText('MCP Agent listening')).toBeInTheDocument(),
    );
  });
});
