import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import Cookies from 'js-cookie';
import { useAuthStore } from '@/store/authStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('API');

// Use relative URL - Next.js rewrites handle routing to backend
export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
  withCredentials: true, // Include cookies in cross-origin requests (for OIDC httpOnly cookie auth)
});

// Request interceptor to add auth token and CSRF token
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = Cookies.get('auth_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    const csrfToken = Cookies.get('csrf_token');
    if (csrfToken && config.headers) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
    logger.debug(`${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
let isLoggingOut = false;
let isRefreshingCsrf = false;
let csrfRefreshPromise: Promise<boolean> | null = null;

async function refreshCsrfToken(): Promise<boolean> {
  try {
    // GET request skips CSRF guard; auth_token httpOnly cookie is sent automatically
    await axios.get('/api/v1/auth/csrf-refresh', { withCredentials: true });
    logger.info('CSRF token refreshed');
    return true;
  } catch (_) {
    return false;
  }
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _csrfRetried?: boolean };

    // Handle 403 CSRF errors — attempt transparent refresh and retry
    if (
      error.response?.status === 403 &&
      !originalRequest?._csrfRetried &&
      typeof (error.response?.data as any)?.message === 'string' &&
      (error.response.data as any).message.includes('CSRF token')
    ) {
      originalRequest._csrfRetried = true;

      // Deduplicate concurrent refresh attempts
      if (!isRefreshingCsrf) {
        isRefreshingCsrf = true;
        csrfRefreshPromise = refreshCsrfToken();
      }

      const refreshed = await csrfRefreshPromise;
      isRefreshingCsrf = false;
      csrfRefreshPromise = null;

      if (refreshed) {
        // Re-read the fresh CSRF cookie and retry the original request
        const newCsrfToken = Cookies.get('csrf_token');
        if (newCsrfToken && originalRequest.headers) {
          originalRequest.headers['X-CSRF-Token'] = newCsrfToken;
        }
        return apiClient(originalRequest);
      }

      // CSRF refresh failed (auth also expired) — fall through to logout
      logger.warn('CSRF refresh failed, session expired');
    }

    if (error.response?.status === 401 && !isLoggingOut) {
      isLoggingOut = true;
      logger.warn('401 received, logging out');
      // Token expired or invalid, logout user
      const { logout } = useAuthStore.getState();
      logout();

      // Call backend to clear the httpOnly cookie
      try {
        await axios.post('/api/v1/auth/logout', {}, { withCredentials: true });
      } catch (_) {
        // Ignore errors - backend may be unreachable
      }

      // Redirect to login if not already there
      if (typeof window !== 'undefined' && !window.location.pathname.includes('/login')) {
        window.location.href = '/login';
      }
      isLoggingOut = false;
    }

    return Promise.reject(error);
  }
);

export default apiClient;
