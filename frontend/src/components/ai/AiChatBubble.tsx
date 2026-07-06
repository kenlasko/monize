'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useIsMobile } from '@/hooks/useIsMobile';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

// The chat pulls in markdown/chart dependencies, so load it only when the
// bubble is actually opened (and never on the server) to keep it out of the
// global bundle that ships on every authenticated page.
const ChatInterface = dynamic(
  () => import('./ChatInterface').then((m) => m.ChatInterface),
  {
    ssr: false,
    loading: () => (
      <div className="flex flex-1 items-center justify-center">
        <LoadingSpinner />
      </div>
    ),
  },
);

// Routes where the bubble is suppressed. The dedicated full-page chat already
// renders ChatInterface, so a bubble there would duplicate it.
const HIDE_ON = ['/ai'];

type View = 'closed' | 'sheet' | 'full';

// Desktop floating panel geometry (matches the Tailwind sizing below) and the
// margin the panel keeps from the viewport edges when snapped to a corner.
const PANEL_W = 420;
const PANEL_H = 600;
const EDGE_MARGIN = 16;

const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'] as const;
type Corner = (typeof CORNERS)[number];

type Position = { x: number; y: number };
// Persisted per-device ergonomic setting (like column widths): the free-drag
// top-left offset plus the corner the snap-cycle button last landed on.
type Placement = { x: number; y: number; corner: Corner };

const STORAGE_KEY = 'monize.aiBubble.placement';

function cornerToPosition(corner: Corner): Position {
  if (typeof window === 'undefined') return { x: EDGE_MARGIN, y: EDGE_MARGIN };
  const right = Math.max(EDGE_MARGIN, window.innerWidth - PANEL_W - EDGE_MARGIN);
  const bottom = Math.max(EDGE_MARGIN, window.innerHeight - PANEL_H - EDGE_MARGIN);
  switch (corner) {
    case 'bottom-right':
      return { x: right, y: bottom };
    case 'bottom-left':
      return { x: EDGE_MARGIN, y: bottom };
    case 'top-right':
      return { x: right, y: EDGE_MARGIN };
    case 'top-left':
      return { x: EDGE_MARGIN, y: EDGE_MARGIN };
  }
}

// Keep the panel fully on screen. Uses Math.max so a viewport smaller than the
// panel still yields a valid (non-inverted) clamp range.
function clampPosition(p: Position): Position {
  if (typeof window === 'undefined') return p;
  const maxX = Math.max(EDGE_MARGIN, window.innerWidth - PANEL_W - EDGE_MARGIN);
  const maxY = Math.max(EDGE_MARGIN, window.innerHeight - PANEL_H - EDGE_MARGIN);
  return {
    x: Math.min(Math.max(p.x, EDGE_MARGIN), maxX),
    y: Math.min(Math.max(p.y, EDGE_MARGIN), maxY),
  };
}

function readStoredPlacement(): Placement | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Placement>;
    if (
      typeof parsed?.x === 'number' &&
      typeof parsed?.y === 'number' &&
      typeof parsed?.corner === 'string' &&
      (CORNERS as readonly string[]).includes(parsed.corner)
    ) {
      return { x: parsed.x, y: parsed.y, corner: parsed.corner as Corner };
    }
  } catch {
    // Ignore malformed/inaccessible storage and fall back to the default corner.
  }
  return null;
}

function writeStoredPlacement(placement: Placement): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(placement));
  } catch {
    // Storage may be unavailable (private mode / quota); the panel still works.
  }
}

/**
 * App-wide floating AI assistant. A corner launcher opens a bottom sheet that
 * can expand to full screen in place and collapse back. It renders the same
 * <ChatInterface /> as the /ai page; because that component is backed by the
 * singleton aiChatStore, the conversation is shared between the two surfaces.
 *
 * On desktop the floating "sheet" panel is repositionable: drag it by its
 * header (clamped to the viewport) or cycle it between the four corners with
 * the header button. The position is persisted to localStorage per device.
 * Mobile keeps the fixed bottom-sheet, and the full-screen view is unchanged.
 *
 * Mounted once in SwipeShell's authenticated branch, so it self-gates on the
 * opt-in preference and the current route.
 */
export function AiChatBubble() {
  const t = useTranslations('ai.bubble');
  const pathname = usePathname();
  const enabled = usePreferencesStore((s) => s.preferences?.aiBubbleEnabled);
  const isMobile = useIsMobile();
  const [view, setView] = useState<View>('closed');

  // Persisted desktop placement. Lazy-read from localStorage on mount (reading
  // storage for an initial useState value is allowed); null means "use the
  // default bottom-right corner", resolved lazily at render once we have a
  // viewport to measure against.
  const [placement, setPlacement] = useState<Placement | null>(() =>
    readStoredPlacement(),
  );
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
  } | null>(null);

  // Collapse the assistant whenever the route changes (setState during render
  // pattern; a useEffect here would trip react-hooks/set-state-in-effect).
  // Exception: a desktop corner sheet (open, not full-screen) stays open so it
  // persists across pages -- it is non-blocking, so the user can keep chatting
  // while navigating. The full-screen overlay and the mobile bottom sheet (which
  // covers the page behind a scrim) still collapse on navigation.
  const [prevPath, setPrevPath] = useState(pathname);
  if (pathname !== prevPath) {
    setPrevPath(pathname);
    const keepDesktopSheetOpen = view === 'sheet' && !isMobile;
    if (view !== 'closed' && !keepDesktopSheetOpen) setView('closed');
  }

  // Escape steps down one level: full -> sheet -> closed.
  useEffect(() => {
    if (view === 'closed') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setView((v) => (v === 'full' ? 'sheet' : 'closed'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  // Lock background scroll only when fully maximized (it covers the viewport).
  useEffect(() => {
    if (view !== 'full') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [view]);

  if (!enabled) return null;
  if (pathname && HIDE_ON.includes(pathname)) return null;

  if (view === 'closed') {
    return (
      <button
        type="button"
        onClick={() => setView('sheet')}
        aria-label={t('launcherAriaLabel')}
        className="fixed bottom-4 right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-blue-600 text-white shadow-lg transition-colors hover:bg-blue-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-900"
      >
        <ChatIcon className="h-6 w-6" />
      </button>
    );
  }

  const isFull = view === 'full';
  // Only the desktop corner sheet floats and is movable.
  const isFloating = !isFull && !isMobile;
  const currentCorner: Corner = placement?.corner ?? 'bottom-right';
  const position: Position = isFloating
    ? (placement ? { x: placement.x, y: placement.y } : cornerToPosition('bottom-right'))
    : { x: 0, y: 0 };

  const panelClass = isFull
    ? 'fixed inset-0 z-50 flex flex-col bg-white dark:bg-gray-800'
    : isMobile
      ? [
          'fixed z-40 flex flex-col bg-white dark:bg-gray-800 shadow-2xl',
          'inset-x-0 bottom-0 h-[75dvh] rounded-t-2xl border-t border-gray-200 dark:border-gray-700',
        ].join(' ')
      : [
          'fixed z-40 flex flex-col bg-white dark:bg-gray-800 shadow-2xl',
          'h-[600px] max-h-[calc(100dvh-6rem)] w-[420px] rounded-2xl border border-gray-200 dark:border-gray-700',
        ].join(' ');

  const panelStyle = isFloating
    ? { left: `${position.x}px`, top: `${position.y}px` }
    : undefined;

  const nextCorner = CORNERS[(CORNERS.indexOf(currentCorner) + 1) % CORNERS.length];

  const cycleCorner = () => {
    const snapped = cornerToPosition(nextCorner);
    const updated: Placement = { ...snapped, corner: nextCorner };
    setPlacement(updated);
    writeStoredPlacement(updated);
  };

  const onHeaderPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isFloating) return;
    // Don't hijack clicks on the header controls (expand/close/move buttons).
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: position.x,
      originY: position.y,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture is unavailable in some environments (e.g. jsdom).
    }
    setDragging(true);
  };

  const onHeaderPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampPosition({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
    setPlacement({ ...next, corner: currentCorner });
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const next = clampPosition({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    });
    dragRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(drag.pointerId);
    } catch {
      // Ignore if capture was never acquired.
    }
    const updated: Placement = { ...next, corner: currentCorner };
    setPlacement(updated);
    writeStoredPlacement(updated);
  };

  return (
    <>
      {/* Mobile-only scrim for the bottom sheet; the desktop corner panel is
          non-blocking so the user can keep working behind it. */}
      {!isFull && (
        <div
          className="fixed inset-0 z-40 bg-black/30 sm:hidden"
          aria-hidden="true"
          onClick={() => setView('closed')}
        />
      )}

      <div
        role="dialog"
        aria-modal={isFull || undefined}
        aria-label={t('title')}
        className={panelClass}
        style={panelStyle}
      >
        {/* Header. On the desktop floating panel it doubles as the drag handle. */}
        <div
          className={`flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-700 ${
            isFloating ? `touch-none select-none ${dragging ? 'cursor-grabbing' : 'cursor-move'}` : ''
          }`}
          onPointerDown={isFloating ? onHeaderPointerDown : undefined}
          onPointerMove={isFloating ? onHeaderPointerMove : undefined}
          onPointerUp={isFloating ? endDrag : undefined}
          onPointerCancel={isFloating ? endDrag : undefined}
        >
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('title')}
          </h2>
          <div className="flex items-center gap-1">
            {isFloating && (
              <button
                type="button"
                onClick={cycleCorner}
                aria-label={t('moveCorner')}
                title={t('moveCornerTo', { corner: t(`corner.${nextCorner}`) })}
                className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <MoveIcon className="h-5 w-5" />
              </button>
            )}
            {isFull ? (
              <button
                type="button"
                onClick={() => setView('sheet')}
                aria-label={t('collapse')}
                title={t('collapse')}
                className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <CollapseIcon className="h-5 w-5" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setView('full')}
                aria-label={t('expand')}
                title={t('expand')}
                className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
              >
                <ExpandIcon className="h-5 w-5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setView('closed')}
              aria-label={t('close')}
              title={t('close')}
              className="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-200"
            >
              <CloseIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Body: the shared chat. ChatInterface is h-full min-h-0 so it fills
            whatever container we give it. Centred and width-capped when full. */}
        <div
          className={`flex min-h-0 w-full flex-1 flex-col pb-3 ${
            isFull ? 'mx-auto max-w-3xl px-4' : 'px-3'
          }`}
        >
          <ChatInterface />
        </div>
      </div>
    </>
  );
}

function ChatIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8.625 9.75a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375m-13.5 3.01c0 1.6 1.123 2.994 2.707 3.227 1.087.16 2.185.283 3.293.369V21l4.184-4.183a1.14 1.14 0 01.778-.332 48.294 48.294 0 005.83-.498c1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z"
      />
    </svg>
  );
}

function MoveIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7.5 3.75 12 8.25l4.5-4.5M7.5 20.25 12 15.75l4.5 4.5M3.75 7.5 8.25 12l-4.5 4.5M20.25 7.5 15.75 12l4.5 4.5"
      />
    </svg>
  );
}

function ExpandIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15"
      />
    </svg>
  );
}

function CollapseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 9V4.5M9 9H4.5M9 9 3.75 3.75M9 15v4.5M9 15H4.5M9 15l-5.25 5.25M15 9h4.5M15 9V4.5M15 9l5.25-5.25M15 15h4.5M15 15v4.5m0-4.5 5.25 5.25"
      />
    </svg>
  );
}

function CloseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      strokeWidth={1.8}
      stroke="currentColor"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
    </svg>
  );
}
