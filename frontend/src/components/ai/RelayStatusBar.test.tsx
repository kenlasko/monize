import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@/test/render';
import { RelayStatusBar } from './RelayStatusBar';

const getRelayStatus = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getRelayStatus: () => getRelayStatus(),
  },
}));

describe('RelayStatusBar', () => {
  beforeEach(() => {
    getRelayStatus.mockReset();
    getRelayStatus.mockResolvedValue({ state: 'listening', queued: 0 });
  });

  it('renders nothing when relay mode is disabled', () => {
    const { container } = render(<RelayStatusBar enabled={false} />);
    expect(container).toBeEmptyDOMElement();
    expect(getRelayStatus).not.toHaveBeenCalled();
  });

  it('polls status and shows the listening label when enabled', async () => {
    await act(async () => {
      render(<RelayStatusBar enabled />);
    });
    await waitFor(() =>
      expect(screen.getByText('MCP Agent listening')).toBeInTheDocument(),
    );
  });

  it('falls back to offline if the status request fails', async () => {
    getRelayStatus.mockRejectedValue(new Error('boom'));
    await act(async () => {
      render(<RelayStatusBar enabled />);
    });
    await waitFor(() =>
      expect(screen.getByText('MCP Agent offline')).toBeInTheDocument(),
    );
  });

  it('reveals the connect command and loop prompt when help is opened', async () => {
    await act(async () => {
      render(<RelayStatusBar enabled />);
    });
    await act(async () => {
      fireEvent.click(screen.getByText('How to connect'));
    });
    expect(
      screen.getByText(/claude mcp add --transport http monize/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Loop forever: call get_next_prompt/)).toBeInTheDocument();
  });
});
