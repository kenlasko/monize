import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConfirmDialog } from './ConfirmDialog';
import { __resetModalStateForTesting } from './Modal';

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

describe('ConfirmDialog', () => {
  const defaultProps = {
    isOpen: true,
    title: 'Delete Item',
    message: 'Are you sure?',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  it('renders title and message', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Delete Item')).toBeInTheDocument();
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('renders default button labels', () => {
    render(<ConfirmDialog {...defaultProps} />);
    expect(screen.getByText('Confirm')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('renders custom button labels', () => {
    render(<ConfirmDialog {...defaultProps} confirmLabel="Delete" cancelLabel="Keep" />);
    expect(screen.getByText('Delete')).toBeInTheDocument();
    expect(screen.getByText('Keep')).toBeInTheDocument();
  });

  it('calls onConfirm when confirm clicked', () => {
    const onConfirm = vi.fn();
    render(<ConfirmDialog {...defaultProps} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByText('Confirm'));
    expect(onConfirm).toHaveBeenCalled();
  });

  it('calls onCancel when cancel clicked', () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog {...defaultProps} onCancel={onCancel} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalled();
  });

  it('renders nothing when not open', () => {
    const { container } = render(<ConfirmDialog {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  describe('pushHistory', () => {
    beforeEach(() => {
      globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      };
      globalThis.cancelAnimationFrame = vi.fn();
      __resetModalStateForTesting();
    });

    afterEach(() => {
      globalThis.requestAnimationFrame = originalRAF;
      globalThis.cancelAnimationFrame = originalCAF;
      document.body.style.overflow = '';
    });

    it('does not push a history entry by default', async () => {
      const before = window.history.state;
      await act(async () => {
        render(<ConfirmDialog {...defaultProps} />);
      });
      expect(window.history.state).toEqual(before);
    });

    it('pushes a history entry when pushHistory is true', async () => {
      await act(async () => {
        render(<ConfirmDialog {...defaultProps} pushHistory />);
      });
      expect(window.history.state).toMatchObject({ modal: true });
    });
  });
});
