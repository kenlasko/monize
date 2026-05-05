import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MonteCarloSaveAsDialog } from './MonteCarloSaveAsDialog';
import { __resetModalStateForTesting } from '@/components/ui/Modal';

const originalRAF = globalThis.requestAnimationFrame;
const originalCAF = globalThis.cancelAnimationFrame;

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

describe('MonteCarloSaveAsDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <MonteCarloSaveAsDialog
        isOpen={false}
        initialName="Existing"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.queryByText(/Save scenario as/)).not.toBeInTheDocument();
  });

  it('pre-fills the name field with initialName when opened', () => {
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName="Aggressive 25y"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Name$/)).toHaveValue('Aggressive 25y');
  });

  it('updates the field when initialName changes between renders', () => {
    const { rerender } = render(
      <MonteCarloSaveAsDialog
        isOpen={false}
        initialName="First"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    rerender(
      <MonteCarloSaveAsDialog
        isOpen
        initialName="Second"
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/^Name$/)).toHaveValue('Second');
  });

  it('submits the trimmed name', () => {
    const onSubmit = vi.fn();
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName="Old"
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const input = screen.getByLabelText(/^Name$/);
    fireEvent.change(input, { target: { value: '  Trimmed Name  ' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(onSubmit).toHaveBeenCalledWith('Trimmed Name');
  });

  it('truncates the submitted name at 255 characters', () => {
    const onSubmit = vi.fn();
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName=""
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const long = 'x'.repeat(300);
    // The maxLength on the <input> caps user input at 255, so simulate
    // bypassing the attribute by setting the value directly via change event
    // and verifying the submit handler still slices defensively.
    const input = screen.getByLabelText(/^Name$/) as HTMLInputElement;
    Object.defineProperty(input, 'value', { value: long, configurable: true });
    fireEvent.change(input);
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(onSubmit.mock.calls[0][0]).toHaveLength(255);
  });

  it('disables Save when the name is empty or whitespace-only', () => {
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName=""
        onCancel={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const save = screen.getByRole('button', { name: /^Save$/ });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/^Name$/), {
      target: { value: '   ' },
    });
    expect(save).toBeDisabled();
  });

  it('does not invoke onSubmit when the name is empty', () => {
    const onSubmit = vi.fn();
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName=""
        onCancel={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.submit(screen.getByLabelText(/^Name$/).closest('form')!);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('calls onCancel when Cancel is clicked', () => {
    const onCancel = vi.fn();
    render(
      <MonteCarloSaveAsDialog
        isOpen
        initialName="Anything"
        onCancel={onCancel}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(onCancel).toHaveBeenCalled();
  });

  it('pushes a history entry so the back button can close the dialog', async () => {
    const onCancel = vi.fn();
    await act(async () => {
      render(
        <MonteCarloSaveAsDialog
          isOpen
          initialName="Anything"
          onCancel={onCancel}
          onSubmit={vi.fn()}
        />,
      );
    });
    expect(window.history.state).toMatchObject({ modal: true });
  });
});
