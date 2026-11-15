import apiClient from './api';
import {
  rethrowStepUpError,
  useStepUpTokenStore,
} from '@/lib/stepUpToken';
import type {
  EmergencyAccessView,
  EmergencyAccessContact,
  EmergencyAccessMessageMetadata,
  UpsertEmergencyAccessSettings,
  UpsertEmergencyAccessContact,
  EmergencyAccessClaimPreview,
  EmergencyAccessClaimResult,
} from '@/types/emergency-access';

const STEP_UP_PURPOSE = 'emergency-access';

function stepUpHeader(): Record<string, string> {
  const token = useStepUpTokenStore.getState().getValid(STEP_UP_PURPOSE);
  return token ? { 'X-Step-Up-Token': token } : {};
}

export const emergencyAccessApi = {
  get: async (): Promise<EmergencyAccessView> => {
    const res = await apiClient.get<EmergencyAccessView>('/emergency-access');
    return res.data;
  },

  getMessage: async (): Promise<{ message: string | null }> => {
    try {
      const res = await apiClient.get<{ message: string | null }>(
        '/emergency-access/message',
        { headers: stepUpHeader() },
      );
      return res.data;
    } catch (error) {
      rethrowStepUpError(error);
    }
  },

  updateMessage: async (
    message: string | null,
  ): Promise<EmergencyAccessMessageMetadata> => {
    try {
      const res = await apiClient.put<EmergencyAccessMessageMetadata>(
        '/emergency-access/message',
        { message },
        { headers: stepUpHeader() },
      );
      return res.data;
    } catch (error) {
      rethrowStepUpError(error);
    }
  },

  updateSettings: async (
    payload: UpsertEmergencyAccessSettings,
  ): Promise<EmergencyAccessView> => {
    const res = await apiClient.put<EmergencyAccessView>(
      '/emergency-access/settings',
      payload,
    );
    return res.data;
  },

  addContact: async (
    payload: UpsertEmergencyAccessContact,
  ): Promise<EmergencyAccessContact> => {
    const res = await apiClient.post<EmergencyAccessContact>(
      '/emergency-access/contacts',
      payload,
    );
    return res.data;
  },

  updateContact: async (
    id: string,
    payload: UpsertEmergencyAccessContact,
  ): Promise<EmergencyAccessContact> => {
    const res = await apiClient.patch<EmergencyAccessContact>(
      `/emergency-access/contacts/${id}`,
      payload,
    );
    return res.data;
  },

  removeContact: async (id: string): Promise<void> => {
    await apiClient.delete(`/emergency-access/contacts/${id}`);
  },

  reset: async (): Promise<EmergencyAccessView> => {
    const res = await apiClient.post<EmergencyAccessView>(
      '/emergency-access/reset',
    );
    return res.data;
  },

  previewClaim: async (token: string): Promise<EmergencyAccessClaimPreview> => {
    const res = await apiClient.post<EmergencyAccessClaimPreview>(
      '/emergency-access/claim/preview',
      { token },
    );
    return res.data;
  },

  completeClaim: async (
    token: string,
    newPassword: string,
  ): Promise<EmergencyAccessClaimResult> => {
    const res = await apiClient.post<EmergencyAccessClaimResult>(
      '/emergency-access/claim/complete',
      { token, newPassword },
    );
    return res.data;
  },
};
