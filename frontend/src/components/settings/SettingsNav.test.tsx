import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@/test/render';
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

  describe('horizontal variant (mobile tabs)', () => {
    it('renders all section labels', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      for (const section of defaultSections) {
        expect(screen.getByText(section.label)).toBeInTheDocument();
      }
    });

    it('renders with tablist role', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      expect(screen.getByRole('tablist', { name: 'Settings sections' })).toBeInTheDocument();
    });

    it('sets aria-selected on active tab', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="preferences"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      const tabs = screen.getAllByRole('tab');
      const preferencesTab = tabs.find((tab) => tab.textContent === 'Preferences');
      expect(preferencesTab).toHaveAttribute('aria-selected', 'true');
    });

    it('sets aria-selected false on inactive tabs', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="preferences"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      const tabs = screen.getAllByRole('tab');
      const profileTab = tabs.find((tab) => tab.textContent === 'Profile');
      expect(profileTab).toHaveAttribute('aria-selected', 'false');
    });

    it('highlights active tab with blue styling', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="preferences"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      const preferencesTab = screen.getByText('Preferences');
      expect(preferencesTab.className).toContain('bg-blue-100');
      expect(preferencesTab.className).toContain('text-blue-700');
    });

    it('calls onSectionClick when a tab is clicked', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      fireEvent.click(screen.getByText('Danger Zone'));
      expect(onSectionClick).toHaveBeenCalledWith('danger-zone');
    });

    it('renders link sections as anchor elements with external icon', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      const aiLink = screen.getByText('AI Settings').closest('a');
      expect(aiLink).toHaveAttribute('href', '/settings/ai');
      expect(screen.getAllByTestId('external-icon')).toHaveLength(1);
    });

    it('does not call onSectionClick for link tabs', () => {
      render(
        <SettingsNav
          sections={defaultSections}
          activeSection="profile"
          onSectionClick={onSectionClick}
          variant="horizontal"
        />,
      );

      fireEvent.click(screen.getByText('AI Settings'));
      expect(onSectionClick).not.toHaveBeenCalled();
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
