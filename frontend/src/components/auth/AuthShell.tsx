'use client';

import { ReactNode, useEffect, useState } from 'react';
import Image from 'next/image';
import { Card } from '@/components/ui/Card';
import { AuthBrandPanel } from '@/components/auth/AuthBrandPanel';
import { AuthLanguagePicker } from '@/components/auth/AuthLanguagePicker';
import { AppVersion } from '@/components/ui/AppVersion';
import { authApi } from '@/lib/auth';
import { cn } from '@/lib/utils';

interface AuthShellProps {
  /** Page heading under the logo. */
  title?: string;
  /** Line under the title (e.g. the register link on the sign-in page). */
  subtitle?: ReactNode;
  /** Notices rendered between the header and the card (banners, warnings). */
  notices?: ReactNode;
  /** Card body. */
  children: ReactNode;
  /** Wider column for multi-field forms (register). */
  wide?: boolean;
  /**
   * Drop the card surface and render children bare -- for a branch whose body
   * is a single status line or a component that draws its own panel.
   */
  plain?: boolean;
  /** Cookie-only language switcher; only for unauthenticated screens. */
  languagePicker?: boolean;
  /** App version line at the very bottom (the sign-in page shows it). */
  showVersion?: boolean;
}

/**
 * The one shell for the authentication screens (sign-in, register, forgot/
 * reset/change password, verify email, 2FA setup): the form on one half and,
 * from `lg` up, `AuthBrandPanel` on the other. A centered column, the
 * transparent brand mark -- the boxed logo bakes in a white background and
 * rendered as a white square in dark mode -- and the shared Card around the
 * form so the auth pages read like the rest of the app instead of a bare
 * form floating on the page background. `ui-conventions.test.ts` keeps the
 * auth routes on it.
 */
export function AuthShell({
  title,
  subtitle,
  notices,
  children,
  wide = false,
  plain = false,
  languagePicker = false,
  showVersion = false,
}: AuthShellProps) {
  // The administrator may hide the panel (AUTH_BRAND_PANEL). Until the server
  // answers, and if it cannot, the panel shows without its sample-data picture.
  const [methods, setMethods] = useState<{ brandPanel?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    Promise.resolve()
      .then(() => authApi.getAuthMethods())
      .then((result) => {
        if (active) setMethods(result);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const showPanel = methods?.brandPanel !== false;

  return (
    <div
      className={cn(
        'min-h-screen bg-gray-50 dark:bg-gray-900',
        showPanel && 'lg:grid lg:grid-cols-2',
      )}
    >
      <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8">
        <div className={cn('w-full space-y-6', wide ? 'max-w-lg' : 'max-w-md')}>
          <div className="text-center">
            <Image
              src="/icons/monize-logo-transparent.svg"
              alt="Monize"
              width={88}
              height={88}
              className="mx-auto"
              priority
            />
            {title && (
              <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-gray-900 dark:text-gray-100">
                {title}
              </h2>
            )}
            {subtitle && (
              <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">{subtitle}</div>
            )}
          </div>
          {notices}
          {plain ? (
            children
          ) : (
            <Card padding="md" className="sm:p-8">
              {children}
            </Card>
          )}
          {languagePicker && <AuthLanguagePicker />}
          {showVersion && (
            <AppVersion className="text-center text-xs text-gray-400 dark:text-gray-500" />
          )}
        </div>
      </div>
      {showPanel && <AuthBrandPanel showScreenshot={methods !== null} />}
    </div>
  );
}
