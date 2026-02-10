import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders nothing when not open', () => {
    const { container } = render(<Modal isOpen={false}>Content</Modal>);
    expect(container.firstChild).toBeNull();
  });

  it('renders children when open', () => {
    render(<Modal isOpen={true}>Modal Content</Modal>);
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal isOpen={true} onClose={onClose}>Content</Modal>);
    // Click the backdrop overlay (the fixed outer div)
    const backdrop = container.firstChild as HTMLElement;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not propagate click from inner content to backdrop', () => {
    const onClose = vi.fn();
    const { container } = render(<Modal isOpen={true} onClose={onClose}><span>Content</span></Modal>);
    // Click the inner content wrapper (not the backdrop)
    const innerPanel = container.querySelector('.bg-white') as HTMLElement;
    fireEvent.click(innerPanel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose}>Content</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('prevents body scroll when open', () => {
    const { unmount } = render(<Modal isOpen={true}>Content</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });
});
