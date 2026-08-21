import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@/test/render';
import { Modal, __resetModalStateForTesting } from './Modal';

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
  // Reset module-level state to prevent leaks between tests
  __resetModalStateForTesting();
});

afterEach(() => {
  globalThis.requestAnimationFrame = originalRAF;
  globalThis.cancelAnimationFrame = originalCAF;
  document.body.style.overflow = '';
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

  it('renders via portal to document.body', () => {
    render(<Modal isOpen={true}>Portal Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.closest('body')).toBe(document.body);
    expect(screen.getByText('Portal Content')).toBeInTheDocument();
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose}>Content</Modal>);
    const backdrop = screen.getByRole('dialog').parentElement!;
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not propagate click from inner content to backdrop', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose}><span>Content</span></Modal>);
    const dialog = screen.getByRole('dialog');
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('uses the default z-50 backdrop', () => {
    render(<Modal isOpen={true}>Content</Modal>);
    const backdrop = screen.getByRole('dialog').parentElement!;
    expect(backdrop.className).toContain('z-50');
    expect(backdrop.className).not.toContain('z-[65]');
  });

  it('raises the backdrop above the guided-tour overlay when elevated', () => {
    render(<Modal isOpen={true} elevated>Content</Modal>);
    const backdrop = screen.getByRole('dialog').parentElement!;
    // Above the tour spotlight (z-[60]); still below the tour tooltip (z-[70]).
    expect(backdrop.className).toContain('z-[65]');
    expect(backdrop.className).not.toContain('z-50');
  });

  it('pads the backdrop evenly by default', () => {
    render(<Modal isOpen={true}>Content</Modal>);
    const backdrop = screen.getByRole('dialog').parentElement!;
    expect(backdrop.className).toContain('p-4');
    expect(backdrop.className).not.toContain('p-2');
  });

  it('stops submit event propagation from modal content', () => {
    const outerSubmitHandler = vi.fn();
    render(
      <form onSubmit={outerSubmitHandler}>
        <Modal isOpen={true}>
          <form data-testid="inner-form" onSubmit={(e) => { e.preventDefault(); }}>
            <button type="submit">Submit</button>
          </form>
        </Modal>
      </form>
    );
    const dialog = screen.getByRole('dialog');
    const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
    dialog.dispatchEvent(submitEvent);
    expect(outerSubmitHandler).not.toHaveBeenCalled();
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(<Modal isOpen={true} onClose={onClose}>Content</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('prevents body scroll when open', () => {
    const { rerender } = render(<Modal isOpen={true}>Content</Modal>);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Modal isOpen={false}>Content</Modal>);
    expect(document.body.style.overflow).toBe('');
  });

  it('applies maxWidth class', () => {
    render(<Modal isOpen={true} maxWidth="xl">Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('max-w-xl');
  });

  it('applies allowOverflow class', () => {
    render(<Modal isOpen={true} allowOverflow>Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('overflow-visible');
    expect(dialog.className).not.toContain('overflow-y-auto');
  });

  it('applies custom className', () => {
    render(<Modal isOpen={true} className="p-6">Content</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('p-6');
  });

  describe('drawer-left variant', () => {
    it('renders a full-height left sheet pinned to the left edge', () => {
      render(<Modal isOpen={true} variant="drawer-left">Content</Modal>);
      const dialog = screen.getByRole('dialog');
      // Panel is a full-height sheet, not a centered rounded card.
      expect(dialog.className).toContain('h-full');
      expect(dialog.className).not.toContain('rounded-lg');
      expect(dialog.className).not.toContain('max-w-lg');
      // Backdrop pins the panel to the left.
      const backdrop = dialog.parentElement!;
      expect(backdrop.className).toContain('justify-start');
      expect(backdrop.className).not.toContain('justify-center');
    });

    it('animates in from off-screen via the starting-style variant', () => {
      render(<Modal isOpen={true} variant="drawer-left">Content</Modal>);
      const dialog = screen.getByRole('dialog');
      expect(dialog.className).toContain('transition-transform');
      expect(dialog.className).toContain('translate-x-0');
      expect(dialog.className).toContain('starting:-translate-x-full');
    });

    it('still closes on backdrop click in drawer mode', () => {
      const onClose = vi.fn();
      render(
        <Modal isOpen={true} onClose={onClose} variant="drawer-left">Content</Modal>,
      );
      fireEvent.click(screen.getByRole('dialog').parentElement!);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('body overflow ref counting', () => {
    it('keeps body hidden when stacked modal closes but parent remains open', () => {
      const { rerender } = render(
        <>
          <Modal isOpen={true}>Parent</Modal>
          <Modal isOpen={true}>Child</Modal>
        </>,
      );
      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <>
          <Modal isOpen={true}>Parent</Modal>
          <Modal isOpen={false}>Child</Modal>
        </>,
      );
      expect(document.body.style.overflow).toBe('hidden');
    });

    it('restores body overflow only when last modal closes', () => {
      const { rerender } = render(
        <>
          <Modal isOpen={true}>Parent</Modal>
          <Modal isOpen={true}>Child</Modal>
        </>,
      );

      rerender(
        <>
          <Modal isOpen={true}>Parent</Modal>
          <Modal isOpen={false}>Child</Modal>
        </>,
      );
      expect(document.body.style.overflow).toBe('hidden');

      rerender(
        <>
          <Modal isOpen={false}>Parent</Modal>
          <Modal isOpen={false}>Child</Modal>
        </>,
      );
      expect(document.body.style.overflow).toBe('');
    });
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
      const { rerender } = render(<Modal isOpen={true} pushHistory>Content</Modal>);
      expect(pushStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ modal: true }),
        '',
      );
      rerender(<Modal isOpen={false} pushHistory>Content</Modal>);
    });

    it('preserves existing history state when pushing', () => {
      const existingState = { __N: true, url: '/transactions' };
      vi.spyOn(window.history, 'state', 'get').mockReturnValue(existingState);

      const { rerender } = render(<Modal isOpen={true} pushHistory>Content</Modal>);
      expect(pushStateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ __N: true, url: '/transactions', modal: true }),
        '',
      );
      rerender(<Modal isOpen={false} pushHistory>Content</Modal>);
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

    it('closes modal on popstate (browser back button)', () => {
      const onClose = vi.fn();
      render(<Modal isOpen={true} pushHistory onClose={onClose}>Content</Modal>);
      expect(pushStateSpy).toHaveBeenCalledTimes(1);

      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(onClose).toHaveBeenCalled();
      // Clean up: modal was closed via popstate, historyPushedRef is cleared
    });

    it('only topmost modal handles popstate when stacked', () => {
      const parentClose = vi.fn();
      const childClose = vi.fn();

      const { rerender } = render(
        <>
          <Modal isOpen={true} pushHistory onClose={parentClose}>Parent</Modal>
          <Modal isOpen={true} pushHistory onClose={childClose}>Child</Modal>
        </>
      );
      expect(pushStateSpy).toHaveBeenCalledTimes(2);

      // Simulate back button -- only child (topmost) should close
      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(childClose).toHaveBeenCalled();
      expect(parentClose).not.toHaveBeenCalled();

      // Clean up
      rerender(
        <>
          <Modal isOpen={false} pushHistory onClose={parentClose}>Parent</Modal>
          <Modal isOpen={false} pushHistory onClose={childClose}>Child</Modal>
        </>
      );
    });

    it('parent modal does not close when child modal handles popstate', async () => {
      const parentClose = vi.fn();
      const childClose = vi.fn();

      const { rerender } = render(
        <>
          <Modal isOpen={true} pushHistory onClose={parentClose}>Parent</Modal>
          <Modal isOpen={true} pushHistory onClose={childClose}>Child</Modal>
        </>
      );

      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      expect(childClose).toHaveBeenCalledTimes(1);
      expect(parentClose).not.toHaveBeenCalled();

      // Flush microtask for popstateConsumed reset
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });

      // Clean up
      rerender(
        <>
          <Modal isOpen={false} pushHistory onClose={parentClose}>Parent</Modal>
          <Modal isOpen={false} pushHistory onClose={childClose}>Child</Modal>
        </>
      );
    });

    it('cleans up modal stack on unmount', () => {
      const { rerender } = render(
        <Modal isOpen={true} pushHistory>Content</Modal>
      );
      expect(pushStateSpy).toHaveBeenCalledTimes(1);

      // Properly close before unmount
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
      render(
        <Modal isOpen={true} onClose={onClose} onBeforeClose={onBeforeClose}>Content</Modal>
      );

      const backdrop = screen.getByRole('dialog').parentElement!;
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

    it('re-pushes history when onBeforeClose prevents popstate close', () => {
      const pushStateSpy = vi.spyOn(window.history, 'pushState').mockImplementation(() => {});
      vi.spyOn(window.history, 'back').mockImplementation(() => {});

      const onClose = vi.fn();
      const onBeforeClose = vi.fn(() => false);
      render(
        <Modal isOpen={true} pushHistory onClose={onClose} onBeforeClose={onBeforeClose}>Content</Modal>
      );
      expect(pushStateSpy).toHaveBeenCalledTimes(1);

      act(() => {
        window.dispatchEvent(new PopStateEvent('popstate'));
      });

      // Should re-push history entry since close was prevented
      expect(pushStateSpy).toHaveBeenCalledTimes(2);
      expect(onClose).not.toHaveBeenCalled();

      pushStateSpy.mockRestore();
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

      const midInput = screen.getByTestId('input-mid');
      midInput.focus();

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

      expect(screen.getByText('Inside')).toHaveFocus();

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

      const discardBtn = screen.getByTestId('discard-btn');
      discardBtn.focus();
      expect(discardBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab' });

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

      const lastBtn = screen.getByTestId('last-btn');
      lastBtn.focus();
      expect(lastBtn).toHaveFocus();

      fireEvent.keyDown(document, { key: 'Tab' });

      expect(screen.getByTestId('first-btn')).toHaveFocus();
    });
  });
});

describe('Modal header, footer and body', () => {
  beforeEach(() => {
    __resetModalStateForTesting();
  });

  it('names the dialog by its title, so it is not an unlabelled region', () => {
    render(
      <Modal isOpen={true} title="Edit account">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const heading = screen.getByRole('heading', { name: 'Edit account' });
    expect(dialog).toHaveAttribute('aria-labelledby', heading.id);
  });

  it('describes the dialog when a description is given', () => {
    render(
      <Modal isOpen={true} title="Delete" description="This cannot be undone.">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole('dialog');
    const described = document.getElementById(dialog.getAttribute('aria-describedby')!);
    expect(described).toHaveTextContent('This cannot be undone.');
  });

  it('has no aria-labelledby when no title is given, rather than pointing at nothing', () => {
    // The 74 call sites that draw their own header must not gain a dangling
    // reference to an element that was never rendered.
    render(
      <Modal isOpen={true}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-labelledby');
  });

  it('closes from the header button, through the same path as Escape', () => {
    const onClose = vi.fn();
    const onBeforeClose = vi.fn(() => false);
    render(
      <Modal isOpen={true} title="Edit" onClose={onClose} onBeforeClose={onBeforeClose}>
        <p>body</p>
      </Modal>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    // onBeforeClose returning false must veto the close here too -- a second
    // close path that skipped the guard would discard unsaved edits.
    expect(onBeforeClose).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('draws no close button when the modal cannot be closed', () => {
    render(
      <Modal isOpen={true} title="Working">
        <p>body</p>
      </Modal>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
  });

  it('renders a footer when given one', () => {
    render(
      <Modal isOpen={true} title="Edit" footer={<button>Save</button>}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('leaves children unwrapped at the default padding', () => {
    // Several call sites make the panel their own scroll or flex parent, so an
    // unconditional body wrapper would change their layout.
    render(
      <Modal isOpen={true}>
        <p data-testid="child">body</p>
      </Modal>,
    );
    expect(screen.getByTestId('child').parentElement).toBe(screen.getByRole('dialog'));
  });

  it('wraps the body when padding is requested', () => {
    render(
      <Modal isOpen={true} padding="md">
        <p data-testid="child">body</p>
      </Modal>,
    );
    const wrapper = screen.getByTestId('child').parentElement!;
    expect(wrapper).not.toBe(screen.getByRole('dialog'));
    expect(wrapper.className).toContain('p-4');
  });
});

