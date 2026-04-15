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

const mockSetBackendDown = vi.fn();
vi.mock('@/store/connectionStore', () => ({
  useConnectionStore: {
    getState: () => ({
      setBackendDown: mockSetBackendDown,
    }),
  },
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
      // Make the refresh fail so the interceptor doesn't attempt a retry via apiClient
      // (which would trigger a real HTTP request through jsdom)
      const axiosGetSpy = vi.spyOn(axios, 'get').mockRejectedValue(new Error('refresh failed'));

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

      // The refresh will fail, so the error is re-rejected
      try {
        await errorHandler.rejected(mockError);
      } catch {
        // Expected to reject
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

    it('sets backend down on 502 response and rejects', async () => {
      mockSetBackendDown.mockClear();
      vi.resetModules();

      vi.doMock('@/store/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            setBackendDown: mockSetBackendDown,
          }),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');
      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        response: {
          status: 502,
          data: { error: 'Backend unavailable' },
        },
        config: {
          headers: new AxiosHeaders(),
        },
      };

      await expect(errorHandler.rejected(mockError)).rejects.toEqual(mockError);
      expect(mockSetBackendDown).toHaveBeenCalled();
    });

    it('sets backend down on network error (no response) and rejects', async () => {
      mockSetBackendDown.mockClear();
      vi.resetModules();

      vi.doMock('@/store/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            setBackendDown: mockSetBackendDown,
          }),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');
      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        message: 'Network Error',
        config: {
          headers: new AxiosHeaders(),
        },
        // No response property -- network-level failure
      };

      await expect(errorHandler.rejected(mockError)).rejects.toEqual(mockError);
      expect(mockSetBackendDown).toHaveBeenCalled();
    });

    it('does NOT set backend down on client-side timeout (ECONNABORTED)', async () => {
      mockSetBackendDown.mockClear();
      vi.resetModules();

      vi.doMock('@/store/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            setBackendDown: mockSetBackendDown,
          }),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');
      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        code: 'ECONNABORTED',
        message: 'timeout of 10000ms exceeded',
        config: {
          headers: new AxiosHeaders(),
        },
        // No response property -- but this is a client-side timeout,
        // not an actual backend outage.
      };

      await expect(errorHandler.rejected(mockError)).rejects.toEqual(mockError);
      expect(mockSetBackendDown).not.toHaveBeenCalled();
    });

    it('does NOT set backend down on client-side cancellation (ERR_CANCELED)', async () => {
      mockSetBackendDown.mockClear();
      vi.resetModules();

      vi.doMock('@/store/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            setBackendDown: mockSetBackendDown,
          }),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');
      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        code: 'ERR_CANCELED',
        message: 'canceled',
        config: {
          headers: new AxiosHeaders(),
        },
      };

      await expect(errorHandler.rejected(mockError)).rejects.toEqual(mockError);
      expect(mockSetBackendDown).not.toHaveBeenCalled();
    });

    it('does not attempt CSRF or token refresh on 502', async () => {
      mockSetBackendDown.mockClear();
      const axiosGetSpy = vi.spyOn(axios, 'get');
      const axiosPostSpy = vi.spyOn(axios, 'post');

      vi.resetModules();

      vi.doMock('@/store/connectionStore', () => ({
        useConnectionStore: {
          getState: () => ({
            setBackendDown: mockSetBackendDown,
          }),
        },
      }));

      const { apiClient: freshClient } = await import('@/lib/api');
      const interceptors = freshClient.interceptors.response as any;
      const handlers = interceptors.handlers;
      const errorHandler = handlers.find((h: any) => h?.rejected);

      const mockError = {
        response: {
          status: 502,
          data: { error: 'Backend unavailable' },
        },
        config: {
          headers: new AxiosHeaders(),
        },
      };

      try {
        await errorHandler.rejected(mockError);
      } catch {
        // Expected
      }

      // Should not have attempted CSRF refresh or token refresh
      expect(axiosGetSpy).not.toHaveBeenCalledWith('/api/v1/auth/csrf-refresh', expect.anything());
      expect(axiosPostSpy).not.toHaveBeenCalledWith('/api/v1/auth/refresh', expect.anything(), expect.anything());

      axiosGetSpy.mockRestore();
      axiosPostSpy.mockRestore();
    });
  });
});
