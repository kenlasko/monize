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
        const success = searchParams.get('success');
        const error = searchParams.get('error');

        // Handle error from OIDC provider
        if (error) {
          toast.error('Authentication failed. Please try again.');
          router.push('/login');
          return;
        }

        // For OIDC flow, token is in httpOnly cookie
        // For both flows, fetch the user profile to validate authentication
        try {
          const user = await authApi.getProfile();

          // For OIDC, we don't have the token in JS (it's httpOnly)
          // Store a placeholder to indicate we're authenticated via cookie
          login(user, 'httpOnly');

          toast.success('Successfully signed in!');
          if (user.mustChangePassword && user.hasPassword) {
            router.push('/change-password');
          } else {
            router.push('/dashboard');
          }
        } catch (profileError: any) {
          toast.error(!success ? 'No authentication token received' : 'Authentication failed');
          router.push('/login');
        }
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
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="text-center">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
          Completing sign in...
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mt-2">Please wait while we authenticate you</p>
      </div>
    </div>
  );
}

export default function CallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
        <div className="text-center">
          <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Loading...</h2>
        </div>
      </div>
    }>
      <CallbackContent />
    </Suspense>
  );
}
