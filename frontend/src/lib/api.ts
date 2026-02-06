import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';
import Cookies from 'js-cookie';
import { useAuthStore } from '@/store/authStore';

// Use relative URL - Next.js rewrites handle routing to backend
export const apiClient = axios.create({
  baseURL: '/api/v1',
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 10000,
  withCredentials: true, // Include cookies in cross-origin requests (for OIDC httpOnly cookie auth)
});

// Request interceptor to add auth token
apiClient.interceptors.request.use(
  (config: InternalAxiosRequestConfig) => {
    const token = Cookies.get('auth_token');
    if (token && config.headers) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response interceptor to handle errors
let isLoggingOut = false;
apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    if (error.response?.status === 401 && !isLoggingOut) {
      isLoggingOut = true;
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
