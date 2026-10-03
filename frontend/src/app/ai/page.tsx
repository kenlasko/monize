'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageHeader } from '@/components/layout/PageHeader';
import { ChatInterface } from '@/components/ai/ChatInterface';
import { useAuthStore } from '@/store/authStore';
import { discardChatHandoff, peekChatHandoff } from '@/lib/ai-chat-handoff';
import { discardSharedBundle, readSharedBundle } from '@/lib/share-inbox';
import { isShareBundleId } from '@/lib/share-target';
import { createLogger } from '@/lib/logger';

const logger = createLogger('AiPage');

/**
 * Pick up files handed over by the Web Share Target's review screen.
 *
 * The same hand-off the import wizard uses: the review screen routes here with
 * the bundle id rather than the files, and the bundle is discarded once the
 * composer holds their contents, which is what keeps one owner of those bytes.
 * Nothing is asked of the assistant here -- the files land staged on the
 * composer and the user still presses send (INV-SHARE-002).
 */
function useSharedFilesHandoff(): {
  files: File[] | undefined;
  onStaged: () => void;
} {
  const searchParams = useSearchParams();
  const shareId = searchParams?.get('share') ?? null;
  // A bundle belongs to one account; the chat reads it as that reader.
  const viewerUserId = useAuthStore((state) => state.user?.id);
  const [files, setFiles] = useState<File[] | undefined>(undefined);
  const takenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!viewerUserId) return;
    if (!isShareBundleId(shareId ?? '') || takenRef.current === shareId) return;
    takenRef.current = shareId;
    const id = shareId as string;

    const take = async () => {
      const bundle = await readSharedBundle(id, viewerUserId);
      if (!bundle || bundle.expired || bundle.files.length === 0) return;
      setFiles(bundle.files);
    };

    void take().catch((error) => {
      logger.error('Failed to take the shared files into the chat:', error);
    });
  }, [shareId, viewerUserId]);

  // Discarded only after the composer has read the bytes, never on the way in:
  // a stash dropped while the files were still being read would leave the user
  // with neither the share nor the attachments.
  const onStaged = useCallback(() => {
    const id = takenRef.current;
    if (!id) return;
    void discardSharedBundle(id).catch((error) => {
      logger.error('Failed to discard the shared bundle:', error);
    });
  }, []);

  return { files, onStaged };
}

/**
 * Pick up what a screen of this app parked for the chat (`/ai?handoff=<id>`,
 * `lib/ai-chat-handoff.ts`): the receipts page's order email as a text file and
 * the message that asks the assistant about it. The entry is read here and
 * discarded once the composer holds the files, as the share hand-off is.
 * Nothing is asked of the assistant: the files and the text land STAGED on the
 * composer and the user still presses send (INV-SHARE-002's contract).
 */
function useChatHandoff(): {
  id: string | null;
  files: File[] | undefined;
  draft: string | undefined;
  onStaged: () => void;
} {
  const searchParams = useSearchParams();
  const id = searchParams?.get('handoff') ?? null;
  // A pure read of module state: safe to repeat (StrictMode), unlike a take.
  const handoff = useMemo(() => peekChatHandoff(id), [id]);
  const onStaged = useCallback(() => discardChatHandoff(id), [id]);
  return {
    id: handoff ? id : null,
    files: handoff?.files,
    draft: handoff?.draft,
    onStaged,
  };
}

export default function AiPage() {
  return (
    <ProtectedRoute>
      {/* useSearchParams needs a boundary; the chat renders immediately. */}
      <Suspense fallback={<AiChatPage />}>
        <AiChatPageWithShare />
      </Suspense>
    </ProtectedRoute>
  );
}

function AiChatPageWithShare() {
  const shared = useSharedFilesHandoff();
  const handoff = useChatHandoff();
  const files = handoff.files ?? shared.files;
  const onStaged = handoff.files ? handoff.onStaged : shared.onStaged;
  return (
    <AiChatPage
      initialFiles={files}
      onInitialFilesStaged={onStaged}
      initialDraft={handoff.draft}
      chatKey={handoff.id ?? undefined}
    />
  );
}

function AiChatPage({
  initialFiles,
  onInitialFilesStaged,
  initialDraft,
  chatKey,
}: {
  initialFiles?: File[];
  onInitialFilesStaged?: () => void;
  initialDraft?: string;
  /** A new hand-off remounts the chat, so its draft and files are staged afresh. */
  chatKey?: string;
} = {}) {
  const t = useTranslations('ai');
  return (
    /*
      The chat is meant to fit the viewport, so this page is bounded to the
      space below the sticky AppHeader (h-16 = 4rem) and lays its content out
      as a flex column -- not PageLayout's `min-h-screen`, which would force
      the content to >=100vh under the 4rem header and overflow the viewport
      by exactly the header height (the stray page scrollbar this fixes).
      100dvh keeps it correct on mobile where the address bar collapses.
    */
    <div className="flex flex-col h-[calc(100dvh-4rem)] bg-gray-50 dark:bg-gray-900">
      <main className="flex flex-1 min-h-0 flex-col px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl="https://github.com/kenlasko/monize/wiki/AI"
        />
        <div className="flex min-h-0 flex-1 flex-col w-full max-w-4xl mx-auto">
          <ChatInterface
            key={chatKey}
            initialFiles={initialFiles}
            onInitialFilesStaged={onInitialFilesStaged}
            initialDraft={initialDraft}
          />
        </div>
      </main>
    </div>
  );
}
