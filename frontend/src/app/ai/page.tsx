'use client';

import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { ChatInterface } from '@/components/ai/ChatInterface';

export default function AiPage() {
  const t = useTranslations('ai');
  return (
    <ProtectedRoute>
      {/*
        The chat is meant to fit the viewport, so this page is bounded to the
        space below the sticky AppHeader (h-16 = 4rem) and lays its content out
        as a flex column -- not PageLayout's `min-h-screen`, which would force
        the content to >=100vh under the 4rem header and overflow the viewport
        by exactly the header height (the stray page scrollbar this fixes).
        100dvh keeps it correct on mobile where the address bar collapses.
      */}
      <div className="flex flex-col h-[calc(100dvh-4rem)] bg-gray-50 dark:bg-gray-900">
        <main className="flex flex-1 min-h-0 flex-col px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title={t('page.title')}
            subtitle={t('page.subtitle')}
            helpUrl="https://github.com/kenlasko/monize/wiki/AI"
          />
          <div className="flex min-h-0 flex-1 flex-col w-full max-w-4xl mx-auto">
            <ChatInterface />
          </div>
        </main>
      </div>
    </ProtectedRoute>
  );
}
