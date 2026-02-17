import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Modal } from './Modal';

// jsdom doesn't implement requestAnimationFrame reliably for focus management
// We mock it to run callbacks synchronously for testability
const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

beforeEach(() => {
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
});

describe('Modal', () => {
  it('renders nothing when not open', () => {
    const { container } = render(<Modal isOpen={false}>Content</Modal>);
    expect(container.firstChild).toBeNull();
  });

  it('renders children when open', () => {
    render(<Modal isOpen={true}>Modal Content</Modal>);
    expect(screen.getByText('Modal Content')).toBeInTheDocument();
  });

  it('renders with role="dialog" and aria-modal', () => {
    render(<Modal isOpen={true}>Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
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
    render(<Modal isOpen={true} onClose={onClose}><span>Content</span></Modal>);
    // Click the inner content wrapper (not the backdrop)
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
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

  describe('pushHistory', () => {
    let pushStateSpy: ReturnType<typeof vi.spyOn>;
    let backSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      pushStateSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
      backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    });

    afterEach(() => {
      pushStateSpy.mockRestore();
      backSpy.mockRestore();
    });

    it('pushes history entry when modal opens with pushHistory', () => {
      render(<Modal isOpen={true} pushHistory>Content</Modal>);
      expect(pushStateSpy).toHaveBeenCalledWith({ modal: true }, '');
    });

    it('does not push history entry without pushHistory', () => {
      render(<Modal isOpen={true}>Content</Modal>);
      expect(pushStateSpy).not.toHaveBeenCalled();
    });

    it('calls history.back() when modal closes programmatically', () => {
      const { rerender } = render(<Modal isOpen={true} pushHistory>Content</Modal>);
      expect(pushStateSpy).toHaveBeenCalledTimes(1);

      rerender(<Modal isOpen={false} pushHistory>Content</Modal>);
      expect(backSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('onBeforeClose', () => {
    it('prevents close when onBeforeClose returns false (escape)', () => {
      const onClose = vi.fn();
      const onBeforeClose = vi.fn(() => false);
      render(<Modal isOpen={true} onClose={onClose} onBeforeClose={onBeforeClose}>Content</Modal>);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onBeforeClose).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('prevents close when onBeforeClose returns false (backdrop)', () => {
      const onClose = vi.fn();
      const onBeforeClose = vi.fn(() => false);
      const { container } = render(
        <Modal isOpen={true} onClose={onClose} onBeforeClose={onBeforeClose}>Content</Modal>
      );

      const backdrop = container.firstChild as HTMLElement;
      fireEvent.click(backdrop);

      expect(onBeforeClose).toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    });

    it('allows close when onBeforeClose returns undefined', () => {
      const onClose = vi.fn();
      const onBeforeClose = vi.fn(() => undefined);
      render(<Modal isOpen={true} onClose={onClose} onBeforeClose={onBeforeClose}>Content</Modal>);

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(onBeforeClose).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('focus trap', () => {
    it('auto-focuses the first focusable element on open', () => {
      render(
        <Modal isOpen={true}>
          <input data-testid="first-input" />
          <button>OK</button>
        </Modal>,
      );

      expect(screen.getByTestId('first-input')).toHaveFocus();
    });

    it('focuses the modal panel when no focusable children exist', () => {
      render(<Modal isOpen={true}><p>Just text</p></Modal>);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveFocus();
    });

    it('wraps focus from last to first element on Tab', () => {
      render(
        <Modal isOpen={true}>
          <button data-testid="btn-1">First</button>
          <button data-testid="btn-2">Last</button>
        </Modal>,
      );

      const lastBtn = screen.getByTestId('btn-2');
      lastBtn.focus();
      expect(lastBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab' });

      expect(screen.getByTestId('btn-1')).toHaveFocus();
    });

    it('wraps focus from first to last element on Shift+Tab', () => {
      render(
        <Modal isOpen={true}>
          <button data-testid="btn-1">First</button>
          <button data-testid="btn-2">Last</button>
        </Modal>,
      );

      const firstBtn = screen.getByTestId('btn-1');
      firstBtn.focus();
      expect(firstBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

      expect(screen.getByTestId('btn-2')).toHaveFocus();
    });

    it('redirects focus into modal when active element is outside', () => {
      // Create an element outside the modal to focus
      const outsideBtn = document.createElement('button');
      outsideBtn.textContent = 'Outside';
      document.body.appendChild(outsideBtn);

      render(
        <Modal isOpen={true}>
          <button data-testid="modal-btn">Inside</button>
        </Modal>,
      );

      outsideBtn.focus();
      expect(outsideBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab' });

      expect(screen.getByTestId('modal-btn')).toHaveFocus();

      document.body.removeChild(outsideBtn);
    });

    it('prevents Tab when no focusable elements exist', () => {
      render(<Modal isOpen={true}><p>No buttons</p></Modal>);

      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      document.dispatchEvent(event);

      expect(preventSpy).toHaveBeenCalled();
    });

    it('allows Tab between middle elements without interference', () => {
      render(
        <Modal isOpen={true}>
          <button data-testid="btn-1">First</button>
          <input data-testid="input-mid" />
          <button data-testid="btn-2">Last</button>
        </Modal>,
      );

      // Focus the middle element
      const midInput = screen.getByTestId('input-mid');
      midInput.focus();

      // Tab should not be intercepted (not first or last)
      const event = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      const preventSpy = vi.spyOn(event, 'preventDefault');

      document.dispatchEvent(event);

      expect(preventSpy).not.toHaveBeenCalled();
    });

    it('restores focus to previously focused element on close', () => {
      const outsideBtn = document.createElement('button');
      outsideBtn.textContent = 'Trigger';
      document.body.appendChild(outsideBtn);
      outsideBtn.focus();
      expect(outsideBtn).toHaveFocus();

      const { rerender } = render(
        <Modal isOpen={true}>
          <button>Inside</button>
        </Modal>,
      );

      // Modal auto-focused the button inside
      expect(screen.getByText('Inside')).toHaveFocus();

      // Close modal
      rerender(
        <Modal isOpen={false}>
          <button>Inside</button>
        </Modal>,
      );

      expect(outsideBtn).toHaveFocus();

      document.body.removeChild(outsideBtn);
    });

    it('skips disabled buttons in focus trap', () => {
      render(
        <Modal isOpen={true}>
          <button data-testid="enabled-btn">Enabled</button>
          <button disabled data-testid="disabled-btn">Disabled</button>
        </Modal>,
      );

      const enabledBtn = screen.getByTestId('enabled-btn');
      enabledBtn.focus();

      // Tab from the only enabled button should wrap back to itself
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(enabledBtn).toHaveFocus();
    });
  });

  describe('stacked modals', () => {
    it('background modal does not steal focus from foreground modal on Tab', () => {
      render(
        <>
          <Modal isOpen={true}>
            <input data-testid="form-input" />
            <button data-testid="form-btn">Submit</button>
          </Modal>
          <Modal isOpen={true}>
            <button data-testid="discard-btn">Discard</button>
            <button data-testid="cancel-btn">Cancel</button>
            <button data-testid="save-btn">Save</button>
          </Modal>
        </>,
      );

      // Focus the first button of the foreground modal
      const discardBtn = screen.getByTestId('discard-btn');
      discardBtn.focus();
      expect(discardBtn).toHaveFocus();

      // Tab should NOT redirect focus to the background modal's form input
      fireEvent.keyDown(document, { key: 'Tab' });

      // Focus should stay within the foreground modal (not jump to form-input)
      const activeEl = document.activeElement;
      const foregroundDialog = screen.getByTestId('discard-btn').closest('[role="dialog"]');
      expect(foregroundDialog?.contains(activeEl)).toBe(true);
    });

    it('background modal does not handle Escape when foreground modal has focus', () => {
      const bgClose = vi.fn();
      const fgClose = vi.fn();

      render(
        <>
          <Modal isOpen={true} onClose={bgClose}>
            <input data-testid="form-input" />
          </Modal>
          <Modal isOpen={true} onClose={fgClose}>
            <button data-testid="dialog-btn">OK</button>
          </Modal>
        </>,
      );

      const dialogBtn = screen.getByTestId('dialog-btn');
      dialogBtn.focus();

      fireEvent.keyDown(document, { key: 'Escape' });

      expect(fgClose).toHaveBeenCalled();
      expect(bgClose).not.toHaveBeenCalled();
    });

    it('foreground modal Tab wrapping works independently', () => {
      render(
        <>
          <Modal isOpen={true}>
            <input data-testid="form-input" />
            <button data-testid="form-btn">Submit</button>
          </Modal>
          <Modal isOpen={true}>
            <button data-testid="first-btn">First</button>
            <button data-testid="last-btn">Last</button>
          </Modal>
        </>,
      );

      // Focus the last button of the foreground modal
      const lastBtn = screen.getByTestId('last-btn');
      lastBtn.focus();
      expect(lastBtn).toHaveFocus();

      // Tab from last should wrap to first in the foreground modal
      fireEvent.keyDown(document, { key: 'Tab' });

      expect(screen.getByTestId('first-btn')).toHaveFocus();
    });
  });
});
