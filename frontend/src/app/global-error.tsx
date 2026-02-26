'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, sans-serif' }}>
        <div style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '1rem',
          backgroundColor: '#f9fafb',
        }}>
          <div style={{ maxWidth: '28rem', width: '100%', textAlign: 'center' }}>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, color: '#111827', marginBottom: '1rem' }}>
              Something went wrong
            </h1>
            <p style={{ color: '#6b7280', marginBottom: '2rem' }}>
              An unexpected error occurred. Please try again or contact support if the problem persists.
            </p>
            {error.digest && (
              <p style={{ fontSize: '0.875rem', color: '#9ca3af', marginBottom: '1rem' }}>
                Error ID: {error.digest}
              </p>
            )}
            <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
              <button
                onClick={reset}
                style={{
                  padding: '0.75rem 1.5rem',
                  border: 'none',
                  borderRadius: '0.375rem',
                  backgroundColor: '#2563eb',
                  color: '#fff',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Try again
              </button>
              <a
                href="/dashboard"
                style={{
                  padding: '0.75rem 1.5rem',
                  border: '1px solid #d1d5db',
                  borderRadius: '0.375rem',
                  backgroundColor: '#fff',
                  color: '#374151',
                  fontWeight: 500,
                  textDecoration: 'none',
                }}
              >
                Go to Dashboard
              </a>
            </div>
          </div>
        </div>
      </body>
    </html>
  );
}
