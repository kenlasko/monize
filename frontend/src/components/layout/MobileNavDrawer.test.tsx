import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
import { InformationCircleIcon } from '@heroicons/react/24/outline';
import { MobileNavDrawer } from './MobileNavDrawer';

vi.mock('next/image', () => ({
  default: ({ priority, fill, ...props }: any) => <img {...props} />,
}));

const navLinks = [
  { href: '/transactions', label: 'Transactions' },
  { href: '/accounts', label: 'Accounts' },
];
const aiLinks = [
  { href: '/insights', label: 'Insights' },
  { href: '/ai', label: 'AI Assistant' },
];
const toolsLinks = [
  { href: '/categories', label: 'Categories' },
  { href: '/import', label: 'Import Transactions', badge: 'Beta' },
];
const helpEntries: React.ComponentProps<typeof MobileNavDrawer>['helpEntries'] = {
  helpForPage: null,
  actions: [
    { key: 'search', label: 'Search help', onClick: vi.fn(), Icon: InformationCircleIcon },
    { key: 'shortcuts', label: 'Keyboard shortcuts', onClick: vi.fn(), Icon: InformationCircleIcon },
    { key: 'takeTour', label: 'Take the tour', onClick: vi.fn(), Icon: InformationCircleIcon },
    { key: 'whatsNew', label: "What's new", onClick: vi.fn(), Icon: InformationCircleIcon },
  ],
  links: [
    {
      key: 'reportIssue',
      label: 'Report an issue',
      href: 'https://github.com/kenlasko/monize/issues/new',
      Icon: InformationCircleIcon,
    },
    {
      key: 'discussions',
      label: 'Discussions',
      href: 'https://github.com/kenlasko/monize/discussions',
      Icon: InformationCircleIcon,
    },
  ],
};

function renderDrawer(overrides: Partial<React.ComponentProps<typeof MobileNavDrawer>> = {}) {
  const onClose = vi.fn();
  const onNavigate = vi.fn();
  const props: React.ComponentProps<typeof MobileNavDrawer> = {
    isOpen: true,
    onClose,
    pathname: '/dashboard',
    onNavigate,
    navLinks,
    aiLinks,
    showAiMenu: true,
    toolsLinks,
    showAdmin: false,
    helpEntries,
    ...overrides,
  };
  render(<MobileNavDrawer {...props} />);
  return { onClose, onNavigate };
}

describe('MobileNavDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing when closed', () => {
    renderDrawer({ isOpen: false });
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('renders the brand, Dashboard, nav, AI, Tools and Settings entries', () => {
    renderDrawer();
    expect(screen.getByText('Monize')).toBeInTheDocument();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Transactions')).toBeInTheDocument();
    expect(screen.getByText('Accounts')).toBeInTheDocument();
    expect(screen.getByText('AI')).toBeInTheDocument();
    expect(screen.getByText('Insights')).toBeInTheDocument();
    expect(screen.getByText('AI Assistant')).toBeInTheDocument();
    expect(screen.getByText('Categories')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders a badge on a tools link when present', () => {
    renderDrawer();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('hides the AI section when showAiMenu is false', () => {
    renderDrawer({ showAiMenu: false });
    expect(screen.queryByText('Insights')).not.toBeInTheDocument();
    // "AI" section header should be gone too (AI Assistant lives under it)
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument();
  });

  describe('Help section', () => {
    it('renders every action and link, and hides "Help for this page" without one', () => {
      renderDrawer();
      expect(screen.queryByText('Help for this page')).not.toBeInTheDocument();
      expect(screen.getByText('Search help')).toBeInTheDocument();
      expect(screen.getByText('Keyboard shortcuts')).toBeInTheDocument();
      expect(screen.getByText('Take the tour')).toBeInTheDocument();
      expect(screen.getByText("What's new")).toBeInTheDocument();
      const reportIssue = screen.getByText('Report an issue').closest('a');
      expect(reportIssue).toHaveAttribute(
        'href',
        'https://github.com/kenlasko/monize/issues/new',
      );
      expect(reportIssue).toHaveAttribute('target', '_blank');
      expect(screen.getByText('Discussions').closest('a')).toHaveAttribute(
        'href',
        'https://github.com/kenlasko/monize/discussions',
      );
    });

    it('shows "Help for this page" when the current page has a help key', () => {
      renderDrawer({
        helpEntries: {
          ...helpEntries,
          helpForPage: {
            key: 'helpForPage',
            label: 'Help for this page',
            onClick: vi.fn(),
            Icon: InformationCircleIcon,
          },
        },
      });
      expect(screen.getByText('Help for this page')).toBeInTheDocument();
    });

    it('runs an action and closes the drawer', () => {
      const onClick = vi.fn();
      const { onClose } = renderDrawer({
        helpEntries: {
          ...helpEntries,
          actions: [{ key: 'search', label: 'Search help', onClick, Icon: InformationCircleIcon }],
        },
      });
      fireEvent.click(screen.getByText('Search help'));
      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('closes the drawer from an external link too', () => {
      const { onClose } = renderDrawer();
      fireEvent.click(screen.getByText('Discussions'));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('omits the Tools section when there are no tools links', () => {
    renderDrawer({ toolsLinks: [] });
    expect(screen.queryByText('Tools')).not.toBeInTheDocument();
    expect(screen.queryByText('Categories')).not.toBeInTheDocument();
  });

  it('shows the Admin section only when showAdmin is true', () => {
    renderDrawer({ showAdmin: true });
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('User Management')).toBeInTheDocument();
  });

  it('navigates when a link is clicked', () => {
    const { onNavigate } = renderDrawer();
    fireEvent.click(screen.getByText('Transactions'));
    expect(onNavigate).toHaveBeenCalledWith('/transactions');
  });

  it('navigates to the dashboard from the brand button', () => {
    const { onNavigate } = renderDrawer();
    fireEvent.click(screen.getByText('Monize'));
    expect(onNavigate).toHaveBeenCalledWith('/dashboard');
  });

  it('closes when the close button is clicked', () => {
    const { onClose } = renderDrawer();
    fireEvent.click(screen.getByLabelText('Close menu'));
    expect(onClose).toHaveBeenCalled();
  });

  it('highlights the active route', () => {
    renderDrawer({ pathname: '/transactions' });
    const active = screen.getByText('Transactions').closest('button');
    expect(active?.className).toContain('bg-blue-50');
  });

  it('highlights the Admin entry when on an admin route', () => {
    renderDrawer({ showAdmin: true, pathname: '/admin/users' });
    const active = screen.getByText('User Management').closest('button');
    expect(active?.className).toContain('bg-blue-50');
  });
});
