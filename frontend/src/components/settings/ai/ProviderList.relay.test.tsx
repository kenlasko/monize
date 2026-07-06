import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@/test/render';
import { ProviderList } from './ProviderList';
import type { AiProviderConfig } from '@/types/ai';

const mockGetRelayStatus = vi.fn();

vi.mock('@/lib/ai', () => ({
  aiApi: {
    getRelayStatus: () => mockGetRelayStatus(),
    updateConfig: vi.fn(),
    deleteConfig: vi.fn(),
    createConfig: vi.fn(),
    testConnection: vi.fn(),
  },
}));

const relayConfig: AiProviderConfig = {
  id: 'relay-1',
  provider: 'mcp_relay',
  displayName: null,
  isActive: true,
  priority: 0,
  model: null,
  apiKeyMasked: null,
  baseUrl: null,
  config: {},
  inputCostPer1M: null,
  outputCostPer1M: null,
  costCurrency: 'USD',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
};

describe('ProviderList — MCP Relay row', () => {
  beforeEach(() => {
    mockGetRelayStatus.mockReset();
    mockGetRelayStatus.mockResolvedValue({ state: 'listening', queued: 0 });
  });

  it('shows the live relay status and no Test button', async () => {
    await act(async () => {
      render(
        <ProviderList
          configs={[relayConfig]}
          encryptionAvailable
          onConfigsChanged={() => {}}
        />,
      );
    });

    expect(screen.getByText('MCP Relay')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText('MCP Agent listening')).toBeInTheDocument(),
    );
    // Relay rows have no connection Test button (nothing to probe).
    expect(screen.queryByText('Test')).not.toBeInTheDocument();
  });
});
