import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@/test/render';
import { PageHeader } from './PageHeader';

const openHelp = vi.fn();
vi.mock('@/lib/help-open', () => ({ openHelp: (link: string) => openHelp(link) }));

const HELP_LINK = { name: 'Help for this page' };

beforeEach(() => {
  openHelp.mockReset();
});

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="My Page" />);
    expect(screen.getByRole('heading', { name: 'My Page' })).toBeInTheDocument();
  });

  it('renders the subtitle when provided', () => {
    render(<PageHeader title="My Page" subtitle="A helpful description" />);
    expect(screen.getByText('A helpful description')).toBeInTheDocument();
  });

  it('does not render subtitle when not provided', () => {
    render(<PageHeader title="My Page" />);
    expect(screen.queryByText('A helpful description')).not.toBeInTheDocument();
  });

  it('renders action buttons when provided', () => {
    render(
      <PageHeader
        title="My Page"
        actions={<button>Add New</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Add New' })).toBeInTheDocument();
  });

  it('does not render actions container when no actions provided', () => {
    const { container } = render(<PageHeader title="My Page" />);
    // No flex-wrap actions container should exist
    const actionsContainer = container.querySelector('.flex.flex-wrap');
    expect(actionsContainer).toBeNull();
  });

  it('renders a help link when help is provided', () => {
    render(<PageHeader title="My Page" help="budgets" />);
    expect(screen.getByRole('link', HELP_LINK)).toBeInTheDocument();
  });

  it('keeps the help link pointing at the same page on monize.net, for a new tab or a copied link', () => {
    render(<PageHeader title="My Page" help="institutions" />);
    const helpLink = screen.getByRole('link', HELP_LINK);
    expect(helpLink).toHaveAttribute(
      'href',
      'https://www.monize.net/docs/accounts#financial-institutions',
    );
    expect(helpLink).toHaveAttribute('target', '_blank');
    expect(helpLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not render a help link when help is omitted', () => {
    render(<PageHeader title="My Page" />);
    expect(screen.queryByRole('link', HELP_LINK)).not.toBeInTheDocument();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  describe('opening the help panel', () => {
    // jsdom cannot navigate; record whether the click's default action survived.
    const clickAndReport = (init: MouseEventInit = {}) => {
      const link = screen.getByRole('link', HELP_LINK);
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
      link.dispatchEvent(event);
      return event.defaultPrevented;
    };

    it('opens the panel at the key on a plain click, and keeps the browser from navigating', () => {
      render(<PageHeader title="My Page" help="budgets" />);
      expect(clickAndReport()).toBe(true);
      expect(openHelp).toHaveBeenCalledTimes(1);
      expect(openHelp).toHaveBeenCalledWith('budgets');
    });

    it.each([
      ['Ctrl', { ctrlKey: true }],
      ['Cmd', { metaKey: true }],
      ['Shift', { shiftKey: true }],
      ['Alt', { altKey: true }],
      ['middle', { button: 1 }],
    ])('leaves a %s-click to the browser', (_name, init) => {
      render(<PageHeader title="My Page" help="budgets" />);
      expect(clickAndReport(init)).toBe(false);
      expect(openHelp).not.toHaveBeenCalled();
    });

    it('opens the panel from the keyboard', () => {
      render(<PageHeader title="My Page" help="tags" />);
      // A link's Enter key dispatches a click.
      fireEvent.click(screen.getByRole('link', HELP_LINK));
      expect(openHelp).toHaveBeenCalledWith('tags');
    });
  });

  it('shows a tooltip saying what the icon is for', () => {
    render(<PageHeader title="My Page" help="budgets" />);
    expect(screen.getByRole('tooltip', HELP_LINK)).toBeInTheDocument();
  });

  it('shows the help tooltip on hover and focus at every width, not only from md up', () => {
    render(<PageHeader title="My Page" help="budgets" />);
    const tooltip = screen.getByRole('tooltip', HELP_LINK);
    expect(tooltip.className).toContain('group-hover/help:block');
    expect(tooltip.className).toContain('group-focus-within/help:block');
    expect(tooltip.className).not.toMatch(/\b(sm|md|lg):group-hover/);
  });

  it('renders help link alongside action buttons when both are provided', () => {
    render(
      <PageHeader
        title="My Page"
        help="budgets"
        actions={<button>Add New</button>}
      />,
    );
    expect(screen.getByRole('link', HELP_LINK)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add New' })).toBeInTheDocument();
  });

  it('stacks actions below the title on mobile by default', () => {
    const { container } = render(
      <PageHeader title="My Page" actions={<button>Add New</button>} />,
    );
    // Default layout is a column on mobile and the actions span full width.
    expect(container.querySelector('.flex.flex-col')).not.toBeNull();
    const actionsContainer = container.querySelector('.flex.flex-wrap');
    expect(actionsContainer?.className).toContain('w-full');
  });

  it('keeps actions inline on mobile when compactMobileActions is set', () => {
    const { container } = render(
      <PageHeader
        title="My Page"
        compactMobileActions
        actions={<button>Add New</button>}
      />,
    );
    // Row layout even on mobile, and the actions container is not full width.
    expect(container.querySelector('.flex.flex-col')).toBeNull();
    expect(container.querySelector('.flex.flex-row')).not.toBeNull();
    const actionsContainer = container.querySelector('.flex.flex-wrap');
    expect(actionsContainer?.className).not.toContain('w-full');
  });

  it('renders help link next to title when no other actions are provided', () => {
    const { container } = render(
      <PageHeader title="My Page" help="budgets" />,
    );
    expect(screen.getByRole('link', HELP_LINK)).toBeInTheDocument();
    // No actions container should exist when only help is provided
    const actionsContainer = container.querySelector('.flex.flex-wrap');
    expect(actionsContainer).toBeNull();
  });

  it('draws an adornment on the title line, outside the heading', () => {
    render(<PageHeader title="Laptop" titleAdornment={<span>Active</span>} />);
    const heading = screen.getByRole('heading', { name: 'Laptop' });
    const pill = screen.getByText('Active');
    expect(heading).not.toContainElement(pill);
    expect(heading.parentElement).toContainElement(pill);
  });
});
