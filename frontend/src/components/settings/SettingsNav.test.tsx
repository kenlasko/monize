import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@/test/render';
import { SettingsNav, SettingsSection } from './SettingsNav';

// Mock next/link
vi.mock('next/link', () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

// Mock heroicons
vi.mock('@heroicons/react/20/solid', () => ({
  ArrowTopRightOnSquareIcon: (props: any) => <svg data-testid="external-icon" {...props} />,
  ChevronDownIcon: (props: any) => <svg data-testid="chevron-icon" {...props} />,
}));

const defaultSections: SettingsSection[] = [
  { id: 'profile', label: 'Profile' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'security', label: 'Security' },
  { id: 'ai-settings', label: 'AI Settings', href: '/settings/ai' },
  { id: 'danger-zone', label: 'Danger Zone' },
];

describe('SettingsNav', () => {
  const onSectionClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('vertical variant (desktop sidebar)', () => {
    it('renders all section labels', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      for (const section of defaultSections) {
        expect(screen.getByText(section.label)).toBeInTheDocument();
      }
    });

    it('renders as a nav element with correct aria-label', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    });

    it('highlights the active section with blue styling', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="security"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const securityButton = screen.getByText('Security');
      expect(securityButton.className).toContain('bg-blue-50');
      expect(securityButton.className).toContain('text-blue-700');
    });

    it('applies inactive styling to non-active sections', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="security"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const profileButton = screen.getByText('Profile');
      expect(profileButton.className).toContain('text-gray-700');
      expect(profileButton.className).not.toContain('bg-blue-50');
    });

    it('calls onSectionClick when a regular section is clicked', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      fireEvent.click(screen.getByText('Security'));
      expect(onSectionClick).toHaveBeenCalledWith('security');
    });

    it('does not call onSectionClick for link sections', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      fireEvent.click(screen.getByText('AI Settings'));
      expect(onSectionClick).not.toHaveBeenCalled();
    });

    it('renders link sections as anchor elements with correct href', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const aiLink = screen.getByText('AI Settings').closest('a');
      expect(aiLink).toHaveAttribute('href', '/settings/ai');
    });

    it('shows external icon for link sections', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const externalIcons = screen.getAllByTestId('external-icon');
      expect(externalIcons).toHaveLength(1);
    });

    it('renders regular sections as buttons', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const buttons = screen.getAllByRole('button');
      // 4 regular sections (profile, preferences, security, danger-zone) are buttons
      expect(buttons).toHaveLength(4);
    });

    it('renders sections in a list', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const listItems = screen.getAllByRole('listitem');
      expect(listItems).toHaveLength(defaultSections.length);
    });

    it('applies active styling to link sections when active', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="ai-settings"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const aiLink = screen.getByText('AI Settings').closest('a');
      expect(aiLink?.className).toContain('bg-blue-50');
    });
  });

  describe('dropdown variant (mobile)', () => {
    const renderDropdown = (activeSection: string) =>
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection={activeSection}
          onSectionClick={onSectionClick}
          variant="dropdown"
        />,
      );

    const openMenu = () => {
      fireEvent.click(screen.getByRole('button', { expanded: false }));
    };

    it('shows the active section label in a collapsed trigger', () => {
      renderDropdown('preferences');

      const trigger = screen.getByRole('button');
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveTextContent('Preferences');
      // Collapsed: the menu (and its other sections) is not rendered yet.
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
      expect(screen.queryByText('Security')).not.toBeInTheDocument();
    });

    it('opens the menu listing every section when the trigger is clicked', () => {
      renderDropdown('profile');
      openMenu();

      expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
      const menu = screen.getByRole('navigation', { name: 'Settings sections' });
      expect(menu).toBeInTheDocument();
      for (const section of defaultSections) {
        // Active label appears in both the trigger and the menu.
        expect(screen.getAllByText(section.label).length).toBeGreaterThanOrEqual(1);
      }
    });

    it('highlights the active section in the open menu with blue styling', () => {
      renderDropdown('preferences');
      openMenu();

      const menu = screen.getByRole('navigation', { name: 'Settings sections' });
      const activeItem = within(menu).getByText('Preferences');
      expect(activeItem.className).toContain('bg-blue-50');
      expect(activeItem.className).toContain('text-blue-700');
    });

    it('calls onSectionClick and closes the menu when a section is selected', () => {
      renderDropdown('profile');
      openMenu();

      const menu = screen.getByRole('navigation', { name: 'Settings sections' });
      fireEvent.click(within(menu).getByText('Security'));

      expect(onSectionClick).toHaveBeenCalledWith('security');
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('renders link sections as anchor elements with external icon', () => {
      renderDropdown('profile');
      openMenu();

      const aiLink = screen.getByText('AI Settings').closest('a');
      expect(aiLink).toHaveAttribute('href', '/settings/ai');
      expect(screen.getAllByTestId('external-icon')).toHaveLength(1);
    });

    it('does not call onSectionClick for link sections', () => {
      renderDropdown('profile');
      openMenu();

      fireEvent.click(screen.getByText('AI Settings'));
      expect(onSectionClick).not.toHaveBeenCalled();
    });

    it('closes the menu on Escape', () => {
      renderDropdown('profile');
      openMenu();
      expect(screen.getByRole('navigation')).toBeInTheDocument();

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });

    it('closes the menu when clicking outside', () => {
      renderDropdown('profile');
      openMenu();
      expect(screen.getByRole('navigation')).toBeInTheDocument();

      fireEvent.mouseDown(document.body);
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    });
  });

  describe('with empty sections', () => {
    it('renders nothing meaningful with an empty sections array', () => {
      const { container } = render(
        <SettingsNav
          sections={[]}
          activeSection=""
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const nav = container.querySelector('nav');
      expect(nav).toBeInTheDocument();
      expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    });
  });

  describe('danger variant styling', () => {
    const dangerSections: SettingsSection[] = [
      { id: 'profile', label: 'Profile' },
      { id: 'danger-zone', label: 'Danger Zone', variant: 'danger' },
    ];

    it('renders a danger section in red text in the vertical sidebar', () => {
      render(
        <SettingsNav
          sections={dangerSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const dangerButton = screen.getByText('Danger Zone');
      expect(dangerButton.className).toContain('text-red-600');
      expect(dangerButton.className).not.toContain('text-gray-700');
    });

    it('renders an active danger section with red background in the vertical sidebar', () => {
      render(
        <SettingsNav
          sections={dangerSections}
          activeSection="danger-zone"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const dangerButton = screen.getByText('Danger Zone');
      expect(dangerButton.className).toContain('bg-red-50');
      expect(dangerButton.className).toContain('text-red-700');
      expect(dangerButton.className).not.toContain('bg-blue-50');
    });

    it('renders a danger section in red text in the open dropdown menu', () => {
      render(
        <SettingsNav
          sections={dangerSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="dropdown"
        />,
      );

      fireEvent.click(screen.getByRole('button', { expanded: false }));
      const menu = screen.getByRole('navigation', { name: 'Settings sections' });
      const dangerItem = within(menu).getByText('Danger Zone');
      expect(dangerItem.className).toContain('text-red-600');
    });

    it('leaves non-danger sections with their default gray styling', () => {
      render(
        <SettingsNav
          sections={dangerSections}
          activeSection="danger-zone"
          onSectionClick={onSectionClick}
          variant="vertical"
        />,
      );

      const profileButton = screen.getByText('Profile');
      expect(profileButton.className).toContain('text-gray-700');
      expect(profileButton.className).not.toContain('text-red-600');
    });
  });

  describe('default variant', () => {
    it('defaults to vertical variant when not specified', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
        />,
      );

      // Vertical variant renders a <nav> element
      expect(screen.getByRole('navigation', { name: 'Settings sections' })).toBeInTheDocument();
    });
  });
});
