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
    // Only the title div should be inside the flex container
    const flexContainer = container.querySelector('.flex.justify-between');
    // Should have exactly one child div (the title area)
    expect(flexContainer?.children.length).toBe(1);
  });
});
