import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiApi } from './ai';

// Mock the apiClient
vi.mock('./api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import apiClient from './api';

describe('aiApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getStatus()', () => {
    it('calls GET /ai/status', async () => {
      const mockData = { configured: true, encryptionAvailable: true, activeProviders: 1 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getStatus();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/status');
      expect(result).toEqual(mockData);
    });
  });

  describe('getConfigs()', () => {
    it('calls GET /ai/configs', async () => {
      const mockData = [{ id: 'c1', provider: 'anthropic' }];
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getConfigs();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/configs');
      expect(result).toEqual(mockData);
    });
  });

  describe('createConfig()', () => {
    it('calls POST /ai/configs with data', async () => {
      const input = { provider: 'anthropic' as const, apiKey: 'sk-key' };
      const mockData = { id: 'c1', provider: 'anthropic' };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockData });

      const result = await aiApi.createConfig(input);

      expect(apiClient.post).toHaveBeenCalledWith('/ai/configs', input);
      expect(result).toEqual(mockData);
    });
  });

  describe('updateConfig()', () => {
    it('calls PATCH /ai/configs/:id with data', async () => {
      const input = { model: 'gpt-4o' };
      const mockData = { id: 'c1', model: 'gpt-4o' };
      vi.mocked(apiClient.patch).mockResolvedValue({ data: mockData });

      const result = await aiApi.updateConfig('c1', input);

      expect(apiClient.patch).toHaveBeenCalledWith('/ai/configs/c1', input);
      expect(result).toEqual(mockData);
    });
  });

  describe('deleteConfig()', () => {
    it('calls DELETE /ai/configs/:id', async () => {
      vi.mocked(apiClient.delete).mockResolvedValue({ data: undefined });

      await aiApi.deleteConfig('c1');

      expect(apiClient.delete).toHaveBeenCalledWith('/ai/configs/c1');
    });
  });

  describe('testConnection()', () => {
    it('calls POST /ai/configs/:id/test', async () => {
      const mockData = { available: true };
      vi.mocked(apiClient.post).mockResolvedValue({ data: mockData });

      const result = await aiApi.testConnection('c1');

      expect(apiClient.post).toHaveBeenCalledWith('/ai/configs/c1/test');
      expect(result).toEqual(mockData);
    });
  });

  describe('getUsage()', () => {
    it('calls GET /ai/usage without params when days not specified', async () => {
      const mockData = { totalRequests: 5 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getUsage();

      expect(apiClient.get).toHaveBeenCalledWith('/ai/usage', { params: {} });
      expect(result).toEqual(mockData);
    });

    it('passes days parameter when specified', async () => {
      const mockData = { totalRequests: 3 };
      vi.mocked(apiClient.get).mockResolvedValue({ data: mockData });

      const result = await aiApi.getUsage(30);

      expect(apiClient.get).toHaveBeenCalledWith('/ai/usage', { params: { days: 30 } });
      expect(result).toEqual(mockData);
    });
  });
});
