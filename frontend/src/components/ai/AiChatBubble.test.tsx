import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { act, render, screen, fireEvent } from '@/test/render';

// Render the lazily-loaded chat as a synchronous stub so these tests exercise
// the bubble's own chrome and gating, not the chat internals.
vi.mock('next/dynamic', () => ({
  default: () =>
    function MockChatInterface() {
      return <div data-testid="chat-interface" />;
    },
}));

let mockPathname = '/dashboard';
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname,
}));

vi.mock('@/store/preferencesStore', () => ({
  usePreferencesStore: vi.fn(),
}));

vi.mock('@/hooks/useIsMobile', () => ({
  useIsMobile: vi.fn(() => false),
}));

vi.mock('@/hooks/useAiConfigured', () => ({
  useAiConfigured: vi.fn(),
}));

import { AiChatBubble } from './AiChatBubble';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useAiConfigured } from '@/hooks/useAiConfigured';
import { useIsMobile } from '@/hooks/useIsMobile';
import { AI_ENTITY_LINK_EVENT } from '@/lib/ai-entity-links';
import { useHelpStore } from '@/store/helpStore';
import { HELP_PANEL_WIDTH } from '@/components/help/help-layout';

function setMobile(mobile: boolean) {
  (useIsMobile as unknown as Mock).mockReturnValue(mobile);
}

function setEnabled(enabled: boolean | undefined) {
  (usePreferencesStore as unknown as Mock).mockImplementation((selector: any) =>
    selector({
      preferences: enabled === undefined ? null : { aiBubbleEnabled: enabled },
    }),
  );
}

const launcher = () => screen.queryByLabelText('Open AI assistant');

/**
 * What `useAiConfigured` reports. It answers `configured: false` until the
 * status settles and for a status read that failed, which is the same
 * "unresolved" state as far as this component is concerned.
 */
function setAiConfigured(configured: boolean, resolved = true) {
  (useAiConfigured as unknown as Mock).mockReturnValue({ configured, resolved });
}

/**
 * Render, then let the provider-status read settle. The bubble draws nothing
 * until it knows whether a provider exists, so a synchronous assertion would
 * only ever catch the not-yet-answered state.
 */
async function renderBubble() {
  const utils = render(<AiChatBubble />);
  await act(async () => {});
  return utils;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockPathname = '/dashboard';
  setEnabled(true);
  setMobile(false);
  setAiConfigured(true);
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

// Viewport is jsdom's default 1024x768; panel is 420x600 with a 16px margin.
const PLACEMENT_KEY = 'monize.aiBubble.placement';
const DEFAULT_LEFT = `${1024 - 420 - 16}px`; // bottom-right
const DEFAULT_TOP = `${768 - 600 - 16}px`;

describe('AiChatBubble', () => {
  it('renders nothing when the preference is off', async () => {
    setEnabled(false);
    await renderBubble();
    expect(launcher()).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing when no AI provider is configured', async () => {
    // The preference outlives the provider that justified it, so an opt-in
    // left on after the last provider was deleted must not put a launcher on
    // every page that opens a chat which can only fail.
    setAiConfigured(false);
    await renderBubble();
    expect(launcher()).not.toBeInTheDocument();
  });

  it('renders nothing until the provider status answers', async () => {
    // Unknown is not yet "yes": drawing the launcher first would make it flash
    // and vanish for everyone without a provider.
    setAiConfigured(false, false);
    await renderBubble();
    expect(launcher()).not.toBeInTheDocument();
  });

  it('renders nothing on the /ai page even when enabled', async () => {
    mockPathname = '/ai';
    await renderBubble();
    expect(launcher()).not.toBeInTheDocument();
  });

  it('shows the launcher (and no panel) when enabled', async () => {
    await renderBubble();
    expect(launcher()).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the bottom sheet with the shared chat when the launcher is clicked', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);

    expect(screen.getByRole('dialog', { name: 'AI Assistant' })).toBeInTheDocument();
    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    expect(screen.getByLabelText('Expand to full screen')).toBeInTheDocument();
    // Launcher is replaced by the panel.
    expect(launcher()).not.toBeInTheDocument();
  });

  it('expands to full screen and collapses back to the sheet', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);

    fireEvent.click(screen.getByLabelText('Expand to full screen'));
    expect(screen.getByLabelText('Collapse to panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Expand to full screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Collapse to panel'));
    expect(screen.getByLabelText('Expand to full screen')).toBeInTheDocument();
  });

  it('closes back to the launcher', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);
    fireEvent.click(screen.getByLabelText('Close'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('keeps a desktop corner sheet open when navigating between pages', async () => {
    const { rerender } = await renderBubble();
    fireEvent.click(launcher()!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Navigate to another page.
    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // The non-blocking desktop sheet persists across the navigation.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(launcher()).not.toBeInTheDocument();
  });

  it('collapses a full-screen view when navigating, even on desktop', async () => {
    const { rerender } = await renderBubble();
    fireEvent.click(launcher()!);
    fireEvent.click(screen.getByLabelText('Expand to full screen'));
    expect(screen.getByLabelText('Collapse to panel')).toBeInTheDocument();

    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // Full screen covers the page, so it collapses back to the launcher.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('collapses the bottom sheet when navigating on mobile', async () => {
    setMobile(true);
    const { rerender } = await renderBubble();
    fireEvent.click(launcher()!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // The mobile bottom sheet sits over a scrim, so it still closes on nav.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('collapses the mobile sheet when an entity deep-link is clicked (query-only nav)', async () => {
    setMobile(true);
    await renderBubble();
    fireEvent.click(launcher()!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Clicking a chat entity link while already on /transactions changes only
    // the query string; the pathname never changes, so the link dispatches
    // this event instead.
    fireEvent(window, new CustomEvent(AI_ENTITY_LINK_EVENT));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('collapses a full-screen view when an entity deep-link is clicked', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);
    fireEvent.click(screen.getByLabelText('Expand to full screen'));

    fireEvent(window, new CustomEvent(AI_ENTITY_LINK_EVENT));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('keeps the desktop corner sheet open when an entity deep-link is clicked', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);

    fireEvent(window, new CustomEvent(AI_ENTITY_LINK_EVENT));

    // Non-blocking desktop sheet persists, same as the route-change rule.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  /** The grip in the panel header: drag it, nudge it, or click to snap. */
  const moveHandle = () => screen.getByLabelText(/Move the panel/);

  it('opens the desktop panel at the default bottom-right corner', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    expect(dialog.style.left).toBe(DEFAULT_LEFT);
    expect(dialog.style.top).toBe(DEFAULT_TOP);
    expect(moveHandle()).toBeInTheDocument();
  });

  it('cycles the panel through corners and persists the new position', async () => {
    await renderBubble();
    fireEvent.click(launcher()!);

    const move = moveHandle();

    // bottom-right -> bottom-left: hugs the left edge, keeps the same bottom.
    fireEvent.click(move);
    const dialog = screen.getByRole('dialog');
    expect(dialog.style.left).toBe('16px');
    expect(dialog.style.top).toBe(DEFAULT_TOP);

    const stored = JSON.parse(window.localStorage.getItem(PLACEMENT_KEY)!);
    expect(stored.corner).toBe('bottom-left');
    expect(stored.x).toBe(16);

    // bottom-left -> top-right: hugs the right edge and the top.
    fireEvent.click(move);
    expect(dialog.style.left).toBe(DEFAULT_LEFT);
    expect(dialog.style.top).toBe('16px');
    expect(JSON.parse(window.localStorage.getItem(PLACEMENT_KEY)!).corner).toBe(
      'top-right',
    );
  });

  it('restores a persisted position when the panel is opened', async () => {
    window.localStorage.setItem(
      PLACEMENT_KEY,
      JSON.stringify({ x: 120, y: 90, corner: 'top-left' }),
    );

    await renderBubble();
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    expect(dialog.style.left).toBe('120px');
    expect(dialog.style.top).toBe('90px');
  });

  it('uses the fixed bottom-sheet (no floating position) on mobile', async () => {
    setMobile(true);
    await renderBubble();
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    // Mobile keeps the CSS-driven bottom sheet: no inline positioning and no
    // reposition control.
    expect(dialog.style.left).toBe('');
    expect(dialog.style.top).toBe('');
    expect(dialog.className).toContain('bottom-0');
    expect(
      screen.queryByLabelText(/Move the panel/),
    ).not.toBeInTheDocument();
  });

  describe('sharing the right edge with the help panel', () => {
    it('collapses an open assistant when help opens', async () => {
      await renderBubble();
      fireEvent.click(launcher()!);
      expect(screen.getByRole('dialog', { name: 'AI Assistant' })).toBeInTheDocument();

      act(() => useHelpStore.getState().openAt({ page: 'budgets' }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(launcher()).toBeInTheDocument();
    });

    it('closes help when the assistant is opened from its launcher', async () => {
      act(() => useHelpStore.getState().openAt({ page: 'budgets' }));
      await renderBubble();

      fireEvent.click(launcher()!);

      expect(useHelpStore.getState().open).toBe(false);
      expect(screen.getByRole('dialog', { name: 'AI Assistant' })).toBeInTheDocument();
    });

    it('lets help open again after the assistant took the edge', async () => {
      await renderBubble();
      fireEvent.click(launcher()!);
      act(() => useHelpStore.getState().openAt({ page: 'budgets' }));
      fireEvent.click(launcher()!);
      expect(useHelpStore.getState().open).toBe(false);
      act(() => useHelpStore.getState().openAt({ page: 'tags' }));
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('moves its launcher clear of the docked panel, and back', async () => {
      await renderBubble();
      expect(launcher()!.style.right).toBe('');

      act(() => useHelpStore.getState().openAt({ page: 'budgets' }));
      expect(launcher()!.style.right).toBe(`${HELP_PANEL_WIDTH + 16}px`);

      act(() => useHelpStore.getState().close());
      expect(launcher()!.style.right).toBe('');
    });

    it('does not move its launcher on a phone, where help is a bottom sheet', async () => {
      setMobile(true);
      await renderBubble();
      act(() => useHelpStore.getState().openAt({ page: 'budgets' }));
      expect(launcher()!.style.right).toBe('');
    });
  });
});
