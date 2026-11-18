import apiClient from '@/lib/api';

/**
 * One app the account has allowed through Monize's OAuth consent screen
 * (Settings > Connected Apps). The name is what the app registered itself as
 * and is never verified; `destinations` are where its authorizations go.
 */
export interface ConnectedApp {
  /** The grant id; what Revoke names. */
  id: string;
  clientId: string;
  clientName: string;
  /** False once the app's registration has expired (it re-registers to reconnect). */
  clientKnown: boolean;
  destinations: string[];
  /** `read` and/or `write`. */
  scopes: string[];
  grantedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export const oauthConnectionsApi = {
  list: async (): Promise<ConnectedApp[]> => {
    const response = await apiClient.get<ConnectedApp[]>('/oauth-connections');
    return response.data;
  },

  revoke: async (id: string): Promise<void> => {
    await apiClient.delete(`/oauth-connections/${encodeURIComponent(id)}`);
  },
};
