import { describe, it, expect } from 'vitest';
import { render, screen } from '@/test/render';
import { PageHeader } from './PageHeader';

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

  it('renders help link when helpUrl is provided', () => {
    render(<PageHeader title="My Page" helpUrl="https://example.com/help" />);
    const helpLink = screen.getByRole('link', { name: /Open the Monize documentation/i });
    expect(helpLink).toBeInTheDocument();
  });

  it('help link has correct href, target, and rel attributes', () => {
    render(<PageHeader title="My Page" helpUrl="https://example.com/help" />);
    const helpLink = screen.getByRole('link', { name: /Open the Monize documentation/i });
    expect(helpLink).toHaveAttribute('href', 'https://example.com/help');
    expect(helpLink).toHaveAttribute('target', '_blank');
    expect(helpLink).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not render help link when helpUrl is omitted', () => {
    render(<PageHeader title="My Page" />);
    expect(screen.queryByRole('link', { name: /Open the Monize documentation/i })).not.toBeInTheDocument();
  });

  it('shows a tooltip describing the documentation destination', () => {
    render(<PageHeader title="My Page" helpUrl="https://example.com/help" />);
    expect(
      screen.getByRole('tooltip', { name: /Open the Monize documentation/i }),
    ).toBeInTheDocument();
  });

  it('shows the help tooltip on hover and focus at every width, not only from md up', () => {
    render(<PageHeader title="My Page" helpUrl="https://example.com/help" />);
    const tooltip = screen.getByRole('tooltip', { name: /Open the Monize documentation/i });
    expect(tooltip.className).toContain('group-hover/help:block');
    expect(tooltip.className).toContain('group-focus-within/help:block');
    expect(tooltip.className).not.toMatch(/\b(sm|md|lg):group-hover/);
  });

  it('renders help link alongside action buttons when both are provided', () => {
    render(
      <PageHeader
        title="My Page"
        helpUrl="https://example.com/help"
        actions={<button>Add New</button>}
      />,
    );
    expect(screen.getByRole('link', { name: /Open the Monize documentation/i })).toBeInTheDocument();
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
      <PageHeader title="My Page" helpUrl="https://example.com/help" />,
    );
    expect(screen.getByRole('link', { name: /Open the Monize documentation/i })).toBeInTheDocument();
    // No actions container should exist when only helpUrl is provided
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
