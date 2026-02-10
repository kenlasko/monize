import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios, { AxiosHeaders, InternalAxiosRequestConfig } from 'axios';
import Cookies from 'js-cookie';

// Mock dependencies before importing apiClient
vi.mock('js-cookie', () => ({
  default: {
    get: vi.fn(),
  },
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({
      logout: vi.fn(),
    })),
  },
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('apiClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is created with baseURL /api/v1', async () => {
    const { apiClient } = await import('@/lib/api');
    expect(apiClient.defaults.baseURL).toBe('/api/v1');
  });

  it('has withCredentials enabled', async () => {
    const { apiClient } = await import('@/lib/api');
    expect(apiClient.defaults.withCredentials).toBe(true);
  });

  it('has Content-Type application/json header', async () => {
    const { apiClient } = await import('@/lib/api');
    expect(apiClient.defaults.headers['Content-Type']).toBe('application/json');
  });

  it('has a 10 second timeout', async () => {
    const { apiClient } = await import('@/lib/api');
    expect(apiClient.defaults.timeout).toBe(10000);
  });

  describe('request interceptor', () => {
    it('attaches CSRF token from cookies to request headers', async () => {
      const { apiClient } = await import('@/lib/api');
      vi.mocked(Cookies.get).mockReturnValue('test-csrf-token' as any);

      const config: InternalAxiosRequestConfig = {
        headers: new AxiosHeaders(),
        method: 'get',
        url: '/test',
      };

      // Run through request interceptors
      const interceptors = apiClient.interceptors.request as any;
      const handlers = interceptors.handlers;
      let result = config;
      for (const handler of handlers) {
        if (handler && handler.fulfilled) {
          result = await handler.fulfilled(result);
        }
      }

      expect(result.headers['X-CSRF-Token']).toBe('test-csrf-token');
    });

    it('does not set CSRF header when no cookie is present', async () => {
      const { apiClient } = await import('@/lib/api');
      vi.mocked(Cookies.get).mockReturnValue(undefined as any);

      const config: InternalAxiosRequestConfig = {
        headers: new AxiosHeaders(),
        method: 'get',
        url: '/test',
      };

      const interceptors = apiClient.interceptors.request as any;
      const handlers = interceptors.handlers;
      let result = config;
      for (const handler of handlers) {
        if (handler && handler.fulfilled) {
          result = await handler.fulfilled(result);
        }
      }

      expect(result.headers['X-CSRF-Token']).toBeUndefined();
    });
  });

  describe('response interceptor', () => {
    it('passes successful responses through', async () => {
      const { apiClient } = await import('@/lib/api');
      const interceptors = apiClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const successHandler = handlers.find((h: any) => h?.fulfilled);

      const mockResponse = { data: { test: true }, status: 200 };
      const result = await successHandler.fulfilled(mockResponse);
      expect(result).toEqual(mockResponse);
    });

    it('attempts CSRF refresh on 403 with CSRF message', async () => {
      const axiosGetSpy = vi.spyOn(axios, 'get').mockResolvedValue({ data: {} });

      // Re-import to get fresh module
      vi.resetModules();
      const { apiClient: freshClient } = await import('@/lib/api');

      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        response: {
          status: 403,
          data: { message: 'Invalid CSRF token' },
        },
        config: {
          headers: new AxiosHeaders(),
          _csrfRetried: false,
        },
      };

      // The retry will attempt to use apiClient again, which will fail.
      // We just verify the CSRF refresh was called.
      try {
        await errorHandler.rejected(mockError);
      } catch {
        // Expected to fail on retry
      }

      expect(axiosGetSpy).toHaveBeenCalledWith('/api/v1/auth/csrf-refresh', { withCredentials: true });
      axiosGetSpy.mockRestore();
    });

    it('attempts token refresh on 401', async () => {
      const axiosPostSpy = vi.spyOn(axios, 'post').mockRejectedValue(new Error('refresh failed'));

      vi.resetModules();

      // Re-mock the store for fresh module
      vi.doMock('@/store/authStore', () => ({
        useAuthStore: {
          getState: vi.fn(() => ({
            logout: vi.fn(),
          })),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');

      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        response: {
          status: 401,
        },
        config: {
          headers: new AxiosHeaders(),
          _authRetried: false,
        },
      };

      try {
        await errorHandler.rejected(mockError);
      } catch {
        // Expected to reject
      }

      expect(axiosPostSpy).toHaveBeenCalledWith(
        '/api/v1/auth/refresh',
        {},
        { withCredentials: true },
      );
      axiosPostSpy.mockRestore();
    });

    it('rejects non-auth/CSRF errors without interception', async () => {
      const { apiClient } = await import('@/lib/api');
      const interceptors = apiClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        response: {
          status: 500,
          data: { message: 'Server error' },
        },
        config: {
          headers: new AxiosHeaders(),
        },
      };

      await expect(errorHandler.rejected(mockError)).rejects.toEqual(mockError);
    });
  });
});
