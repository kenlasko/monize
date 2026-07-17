import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@/test/render';
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

const REPO_URL = 'https://github.com/kenlasko/monize';

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

  it('renders a link to the wiki', () => {
    render(<HelpSection />);
    const link = screen.getByText('Wiki').closest('a');
    expect(link).toHaveAttribute('href', `${REPO_URL}/wiki`);
  });

  it('opens all links in a new tab with safe rel attributes', () => {
    render(<HelpSection />);
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(4);
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
