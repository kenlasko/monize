'use client';

import { useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/lib/auth';
import toast from 'react-hot-toast';

function CallbackContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { login, setLoading, setError } = useAuthStore();

  useEffect(() => {
    const handleCallback = async () => {
      setLoading(true);
      try {
        const token = searchParams.get('token');
        const error = searchParams.get('error');

        if (error) {
          toast.error(decodeURIComponent(error));
          router.push('/login');
          return;
        }

        if (!token) {
          toast.error('No authentication token received');
          router.push('/login');
          return;
        }

        // Store token temporarily
        const { setToken } = useAuthStore.getState();
        setToken(token);

        // Fetch user profile
        const user = await authApi.getProfile();
        login(user, token);

        toast.success('Successfully signed in!');
        router.push('/dashboard');
      } catch (error: any) {
        const message = error.response?.data?.message || 'Authentication failed';
        setError(message);
        toast.error(message);
        router.push('/login');
      } finally {
        setLoading(false);
      }
    };

    handleCallback();
  }, [searchParams, router, login, setLoading, setError]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
        <h2 className="text-xl font-semibold text-gray-900">
          Completing sign in...
        </h2>
        <p className="text-gray-600 mt-2">Please wait while we authenticate you</p>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900">Loading...</h2>
        </div>
      </div>
    }>
      <CallbackContent />
    </Suspense>
  );
}
