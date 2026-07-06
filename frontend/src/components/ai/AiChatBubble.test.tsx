import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';

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

import { AiChatBubble } from './AiChatBubble';
import { usePreferencesStore } from '@/store/preferencesStore';
import { useIsMobile } from '@/hooks/useIsMobile';

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

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mockPathname = '/dashboard';
  setEnabled(true);
  setMobile(false);
});

// Viewport is jsdom's default 1024x768; panel is 420x600 with a 16px margin.
const PLACEMENT_KEY = 'monize.aiBubble.placement';
const DEFAULT_LEFT = `${1024 - 420 - 16}px`; // bottom-right
const DEFAULT_TOP = `${768 - 600 - 16}px`;

describe('AiChatBubble', () => {
  it('renders nothing when the preference is off', () => {
    setEnabled(false);
    render(<AiChatBubble />);
    expect(launcher()).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders nothing on the /ai page even when enabled', () => {
    mockPathname = '/ai';
    render(<AiChatBubble />);
    expect(launcher()).not.toBeInTheDocument();
  });

  it('shows the launcher (and no panel) when enabled', () => {
    render(<AiChatBubble />);
    expect(launcher()).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens the bottom sheet with the shared chat when the launcher is clicked', () => {
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    expect(screen.getByRole('dialog', { name: 'AI Assistant' })).toBeInTheDocument();
    expect(screen.getByTestId('chat-interface')).toBeInTheDocument();
    expect(screen.getByLabelText('Expand to full screen')).toBeInTheDocument();
    // Launcher is replaced by the panel.
    expect(launcher()).not.toBeInTheDocument();
  });

  it('expands to full screen and collapses back to the sheet', () => {
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    fireEvent.click(screen.getByLabelText('Expand to full screen'));
    expect(screen.getByLabelText('Collapse to panel')).toBeInTheDocument();
    expect(screen.queryByLabelText('Expand to full screen')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Collapse to panel'));
    expect(screen.getByLabelText('Expand to full screen')).toBeInTheDocument();
  });

  it('closes back to the launcher', () => {
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);
    fireEvent.click(screen.getByLabelText('Close'));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('keeps a desktop corner sheet open when navigating between pages', () => {
    const { rerender } = render(<AiChatBubble />);
    fireEvent.click(launcher()!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // Navigate to another page.
    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // The non-blocking desktop sheet persists across the navigation.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(launcher()).not.toBeInTheDocument();
  });

  it('collapses a full-screen view when navigating, even on desktop', () => {
    const { rerender } = render(<AiChatBubble />);
    fireEvent.click(launcher()!);
    fireEvent.click(screen.getByLabelText('Expand to full screen'));
    expect(screen.getByLabelText('Collapse to panel')).toBeInTheDocument();

    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // Full screen covers the page, so it collapses back to the launcher.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('collapses the bottom sheet when navigating on mobile', () => {
    setMobile(true);
    const { rerender } = render(<AiChatBubble />);
    fireEvent.click(launcher()!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    mockPathname = '/transactions';
    rerender(<AiChatBubble />);

    // The mobile bottom sheet sits over a scrim, so it still closes on nav.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(launcher()).toBeInTheDocument();
  });

  it('opens the desktop panel at the default bottom-right corner', () => {
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    expect(dialog.style.left).toBe(DEFAULT_LEFT);
    expect(dialog.style.top).toBe(DEFAULT_TOP);
    expect(screen.getByLabelText('Move panel to next corner')).toBeInTheDocument();
  });

  it('cycles the panel through corners and persists the new position', () => {
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    const move = screen.getByLabelText('Move panel to next corner');

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

  it('restores a persisted position when the panel is opened', () => {
    window.localStorage.setItem(
      PLACEMENT_KEY,
      JSON.stringify({ x: 120, y: 90, corner: 'top-left' }),
    );

    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    expect(dialog.style.left).toBe('120px');
    expect(dialog.style.top).toBe('90px');
  });

  it('uses the fixed bottom-sheet (no floating position) on mobile', () => {
    setMobile(true);
    render(<AiChatBubble />);
    fireEvent.click(launcher()!);

    const dialog = screen.getByRole('dialog');
    // Mobile keeps the CSS-driven bottom sheet: no inline positioning and no
    // reposition control.
    expect(dialog.style.left).toBe('');
    expect(dialog.style.top).toBe('');
    expect(dialog.className).toContain('bottom-0');
    expect(
      screen.queryByLabelText('Move panel to next corner'),
    ).not.toBeInTheDocument();
  });
});
