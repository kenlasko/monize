import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@/test/render';
import { useHelpStore } from '@/store/helpStore';
import { HelpSection } from './HelpSection';

// Mock heroicons so the icons render as simple svgs in tests
vi.mock('@heroicons/react/24/outline', () => ({
  ArrowTopRightOnSquareIcon: (props: any) => <svg data-testid="external-icon" {...props} />,
  BookOpenIcon: (props: any) => <svg data-testid="book-icon" {...props} />,
  ChatBubbleLeftRightIcon: (props: any) => <svg data-testid="chat-icon" {...props} />,
  CodeBracketIcon: (props: any) => <svg data-testid="code-icon" {...props} />,
  ExclamationTriangleIcon: (props: any) => <svg data-testid="warning-icon" {...props} />,
  ShieldCheckIcon: (props: any) => <svg data-testid="shield-icon" {...props} />,
}));

// The support-backup modal loads accounts on open; stub it to a no-op panel so
// this section test stays focused on the help links.
vi.mock('./SupportBackupModal', () => ({
  SupportBackupModal: () => null,
}));

const getManifest = vi.fn();
vi.mock('@/lib/help', () => ({ helpApi: { getManifest: () => getManifest() } }));

const REPO_URL = 'https://github.com/kenlasko/monize';

beforeEach(() => {
  getManifest.mockReset();
  getManifest.mockResolvedValue({ version: '1', available: true, pages: [] });
  useHelpStore.setState(useHelpStore.getInitialState(), true);
});

describe('HelpSection', () => {
  it('renders the section heading', () => {
    render(<HelpSection />);
    expect(screen.getByRole('heading', { name: 'Help & Support' })).toBeInTheDocument();
  });

  it('renders a GitHub link to the repository', () => {
    render(<HelpSection />);
    const link = screen.getByText('GitHub').closest('a');
    expect(link).toHaveAttribute('href', REPO_URL);
  });

  it('renders a link to open a new issue', () => {
    render(<HelpSection />);
    const link = screen.getByText('Open an Issue').closest('a');
    expect(link).toHaveAttribute('href', `${REPO_URL}/issues/new`);
  });

  it('renders a link to Discussions', () => {
    render(<HelpSection />);
    const link = screen.getByText('Discussions').closest('a');
    expect(link).toHaveAttribute('href', `${REPO_URL}/discussions`);
  });

  // jsdom cannot navigate; record whether the click's default action survived.
  const clickAndReport = (link: HTMLElement) => {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('opens the guide in the help panel, at the landing page, once the guide is known to be bundled', async () => {
    render(<HelpSection />);
    await waitFor(() => expect(useHelpStore.getState().guideAvailable).toBe(true));
    expect(clickAndReport(screen.getByRole('link', { name: /Documentation/ }))).toBe(true);
    expect(useHelpStore.getState().open).toBe(true);
    expect(useHelpStore.getState().history).toEqual([{ page: 'index' }]);
  });

  it('is a link to monize.net that the browser follows while the guide is not known to be bundled', () => {
    getManifest.mockReturnValue(new Promise(() => {}));
    render(<HelpSection />);
    const tile = screen.getByRole('link', { name: /Documentation/ });
    expect(tile).toHaveAttribute('href', 'https://www.monize.net/docs/');
    expect(tile).toHaveAttribute('target', '_blank');
    expect(clickAndReport(tile)).toBe(false);
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('falls through to monize.net when the server has no bundled guide', async () => {
    getManifest.mockResolvedValue({ version: '1', available: false, pages: [] });
    render(<HelpSection />);
    await waitFor(() => expect(useHelpStore.getState().guideAvailable).toBe(false));
    expect(clickAndReport(screen.getByRole('link', { name: /Documentation/ }))).toBe(false);
    expect(useHelpStore.getState().open).toBe(false);
  });

  it('keeps the guide on monize.net one click away, in a new tab', () => {
    render(<HelpSection />);
    const link = screen.getByRole('link', { name: /Open on monize.net/ });
    expect(link).toHaveAttribute('href', 'https://www.monize.net/docs/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('opens the external links in a new tab with safe rel attributes', () => {
    render(<HelpSection />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(5);
    for (const link of links) {
      expect(link).toHaveAttribute('target', '_blank');
      expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    }
  });

  it('offers a tile-style button to create a support backup', () => {
    render(<HelpSection />);
    expect(
      screen.getByRole('button', { name: /Create a support backup/ }),
    ).toBeInTheDocument();
  });
});
