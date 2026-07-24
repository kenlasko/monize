import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import { Inter } from 'next/font/google';
import { Toaster } from 'react-hot-toast';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { ThemeProvider } from '@/contexts/ThemeContext';
import { PreferencesLoader } from '@/components/providers/PreferencesLoader';
import { ServiceWorkerRegistrar } from '@/components/providers/ServiceWorkerRegistrar';
import { PwaLifecycleHandler } from '@/components/providers/PwaLifecycleHandler';
import { SwipeShell } from '@/components/layout/SwipeShell';
import { WhatsNewHost } from '@/components/whats-new/WhatsNewHost';
import { TourHost } from '@/components/tours/TourHost';
import { getLocaleDir } from '@/i18n/config';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#111827' },
  ],
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export const metadata: Metadata = {
  title: 'Monize - Personal Finance Manager',
  description: 'Track your finances with ease',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Monize',
  },
  icons: {
    icon: [
      { url: '/icons/icon-192x192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/icon-512x512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Reading headers forces dynamic rendering so the per-request CSP nonce
  // from proxy.ts is available. Next.js automatically applies the nonce
  // to its generated inline scripts.
  const headersList = await headers();
  const httpsHeadersActive = headersList.get('x-https-headers-active') === 'true';
  const locale = await getLocale();
  const messages = await getMessages();
  const dir = getLocaleDir(locale);

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className={inter.className}>
        <ServiceWorkerRegistrar />
        <PwaLifecycleHandler />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <PreferencesLoader>
              <SwipeShell httpsHeadersActive={httpsHeadersActive}>
                {children}
              </SwipeShell>
            </PreferencesLoader>
            <WhatsNewHost />
            <TourHost />
            <Toaster
              position="top-right"
              toastOptions={{
                duration: 4000,
                style: {
                  background: '#363636',
                  color: '#fff',
                },
                success: {
                  duration: 3000,
                  iconTheme: {
                    primary: '#10b981',
                    secondary: '#fff',
                  },
                },
                error: {
                  duration: 4000,
                  iconTheme: {
                    primary: '#ef4444',
                    secondary: '#fff',
                  },
                },
              }}
            />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
