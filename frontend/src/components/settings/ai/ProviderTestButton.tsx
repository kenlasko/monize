'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { aiApi } from '@/lib/ai';
import { getErrorMessage } from '@/lib/errors';

interface ProviderTestButtonProps {
  configId: string;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export function ProviderTestButton({ configId }: ProviderTestButtonProps) {
  const [status, setStatus] = useState<TestStatus>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleTest = async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setStatus('testing');
    try {
      const testResult = await aiApi.testConnection(configId);
      if (testResult.available) {
        setStatus('success');
        toast.success('Connection successful');
      } else {
        setStatus('error');
        toast.error(testResult.error || 'Connection failed');
      }
    } catch (error) {
      setStatus('error');
      toast.error(getErrorMessage(error, 'Connection test failed'));
    }
    timerRef.current = setTimeout(() => setStatus('idle'), 3000);
  };

  const className = status === 'success'
    ? 'border-green-500 text-green-600 dark:border-green-400 dark:text-green-400'
    : status === 'error'
      ? 'border-red-500 text-red-600 dark:border-red-400 dark:text-red-400'
      : '';

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleTest}
      disabled={status === 'testing'}
      className={`min-w-[3.5rem] sm:min-w-0 ${className}`}
    >
      {status === 'testing' && (
        <svg className="animate-spin w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      )}
      {status === 'success' && (
        <svg className="w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      )}
      {status === 'error' && (
        <svg className="w-4 h-4 sm:mr-1" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
      <span className={status !== 'idle' ? 'hidden sm:inline' : ''}>Test</span>
    </Button>
  );
}
