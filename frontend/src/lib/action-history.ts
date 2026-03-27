import apiClient from './api';

export interface ActionHistoryItem {
  id: string;
  userId: string;
  entityType: string;
  entityId: string | null;
  action: string;
  isUndone: boolean;
  description: string;
  createdAt: string;
}

export interface UndoRedoResult {
  action: ActionHistoryItem;
  description: string;
}

export const actionHistoryApi = {
  getHistory: async (limit?: number): Promise<ActionHistoryItem[]> => {
    const { data } = await apiClient.get<ActionHistoryItem[]>('/action-history', {
      params: limit ? { limit } : undefined,
    });
    return data;
  },

  undo: async (): Promise<UndoRedoResult> => {
    const { data } = await apiClient.post<UndoRedoResult>('/action-history/undo');
    return data;
  },

  redo: async (): Promise<UndoRedoResult> => {
    const { data } = await apiClient.post<UndoRedoResult>('/action-history/redo');
    return data;
  },
};
