import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LoadingSpinner } from './LoadingSpinner';

describe('LoadingSpinner', () => {
  it('renders spinner', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
  });

  it('shows text when provided', () => {
    render(<LoadingSpinner text="Loading..." />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('does not show text when not provided', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelectorAll('p')).toHaveLength(0);
    expect(container.querySelectorAll('span')).toHaveLength(0);
  });

  it('renders inline when fullContainer is false', () => {
    const { container } = render(<LoadingSpinner fullContainer={false} text="Wait" />);
    expect(container.querySelector('.flex.items-center.gap-2')).toBeInTheDocument();
  });

  it('renders full container by default', () => {
    const { container } = render(<LoadingSpinner />);
    expect(container.querySelector('.p-12.text-center')).toBeInTheDocument();
  });
});
