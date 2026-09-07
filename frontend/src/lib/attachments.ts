import apiClient from './api';
import { Attachment } from '@/types/attachment';
import { invalidateCache } from './apiCache';

/**
 * Same-origin URL for an attachment's bytes. Rendered directly in an <img> (for
 * images) or an <a download> (for any type); the request carries the auth cookie
 * and streams straight from the backend.
 */
export function attachmentDownloadUrl(id: string): string {
  return `/api/v1/attachments/${id}/download`;
}

export const attachmentsApi = {
  list: async (transactionId: string): Promise<Attachment[]> => {
    const response = await apiClient.get<Attachment[]>(
      `/transactions/${transactionId}/attachments`,
    );
    return response.data;
  },

  /**
   * Upload one attachment, optionally with the unprocessed photo it was
   * scanned from.
   *
   * Both parts travel in ONE request because the server writes them in one
   * transaction: uploading the original separately would leave a window where
   * the pair is half stored, and a failure would leave an orphan the user can
   * see but not explain.
   */
  upload: async (
    transactionId: string,
    file: File,
    original?: File,
  ): Promise<Attachment> => {
    const formData = new FormData();
    formData.append('file', file);
    if (original) formData.append('original', original);
    const response = await apiClient.post<Attachment>(
      `/transactions/${transactionId}/attachments`,
      formData,
      { headers: { 'Content-Type': 'multipart/form-data' } },
    );
    invalidateCache('attachments:');
    return response.data;
  },

  delete: async (id: string): Promise<void> => {
    await apiClient.delete(`/attachments/${id}`);
    invalidateCache('attachments:');
  },
};
