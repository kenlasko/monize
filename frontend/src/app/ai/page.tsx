'use client';

import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { ChatInterface } from '@/components/ai/ChatInterface';

export default function AiPage() {
  return (
    <ProtectedRoute>
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title="AI Assistant"
            badge="Beta"
            subtitle="Ask questions about your finances in natural language"
            helpUrl="https://github.com/kenlasko/monize/wiki/AI"
          />
          <div className="max-w-4xl mx-auto">
            <ChatInterface />
          </div>
        </main>
      </PageLayout>
    </ProtectedRoute>
  );
}
