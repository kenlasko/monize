import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFormModal } from './useFormModal';

describe('useFormModal', () => {
  it('starts with form closed and no editing item', () => {
    const { result } = renderHook(() => useFormModal());
    expect(result.current.showForm).toBe(false);
    expect(result.current.editingItem).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('openCreate opens form with no editing item', () => {
    const { result } = renderHook(() => useFormModal());
    act(() => result.current.openCreate());
    expect(result.current.showForm).toBe(true);
    expect(result.current.editingItem).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('openEdit opens form with editing item', () => {
    const { result } = renderHook(() => useFormModal<{ id: string }>());
    act(() => result.current.openEdit({ id: 'item-1' }));
    expect(result.current.showForm).toBe(true);
    expect(result.current.editingItem).toEqual({ id: 'item-1' });
    expect(result.current.isEditing).toBe(true);
  });

  it('close resets form state', () => {
    const { result } = renderHook(() => useFormModal<{ id: string }>());
    act(() => result.current.openEdit({ id: 'item-1' }));
    act(() => result.current.close());
    expect(result.current.showForm).toBe(false);
    expect(result.current.editingItem).toBeUndefined();
    expect(result.current.isEditing).toBe(false);
  });

  it('openCreate clears previous editing item', () => {
    const { result } = renderHook(() => useFormModal<{ id: string }>());
    act(() => result.current.openEdit({ id: 'item-1' }));
    act(() => result.current.openCreate());
    expect(result.current.editingItem).toBeUndefined();
    expect(result.current.showForm).toBe(true);
  });

  describe('modalProps', () => {
    it('has pushHistory set to true', () => {
      const { result } = renderHook(() => useFormModal());
      expect(result.current.modalProps.pushHistory).toBe(true);
    });

    it('onBeforeClose returns undefined when form is clean', () => {
      const { result } = renderHook(() => useFormModal());
      act(() => result.current.openCreate());
      const closeResult = result.current.modalProps.onBeforeClose();
      expect(closeResult).toBeUndefined();
    });

    it('onBeforeClose returns false and opens unsaved dialog when form is dirty', () => {
      const { result } = renderHook(() => useFormModal());
      act(() => result.current.openCreate());
      act(() => result.current.setFormDirty(true));

      let closeResult: boolean | void;
      act(() => { closeResult = result.current.modalProps.onBeforeClose(); });
      expect(closeResult!).toBe(false);
      expect(result.current.unsavedChangesDialog.isOpen).toBe(true);
    });
  });

  describe('unsavedChangesDialog', () => {
    it('starts closed', () => {
      const { result } = renderHook(() => useFormModal());
      expect(result.current.unsavedChangesDialog.isOpen).toBe(false);
    });

    it('onCancel closes dialog but keeps form open', () => {
      const { result } = renderHook(() => useFormModal());
      act(() => result.current.openCreate());
      act(() => result.current.setFormDirty(true));
      act(() => { result.current.modalProps.onBeforeClose(); });

      expect(result.current.unsavedChangesDialog.isOpen).toBe(true);
      expect(result.current.showForm).toBe(true);

      act(() => result.current.unsavedChangesDialog.onCancel());

      expect(result.current.unsavedChangesDialog.isOpen).toBe(false);
      expect(result.current.showForm).toBe(true);
    });

    it('onDiscard closes dialog and form', () => {
      const { result } = renderHook(() => useFormModal());
      act(() => result.current.openCreate());
      act(() => result.current.setFormDirty(true));
      act(() => { result.current.modalProps.onBeforeClose(); });

      act(() => result.current.unsavedChangesDialog.onDiscard());

      expect(result.current.unsavedChangesDialog.isOpen).toBe(false);
      expect(result.current.showForm).toBe(false);
      expect(result.current.editingItem).toBeUndefined();
    });

    it('onSave closes dialog and calls formSubmitRef', () => {
      const { result } = renderHook(() => useFormModal());
      const mockSubmit = vi.fn();
      act(() => result.current.openCreate());
      act(() => { result.current.formSubmitRef.current = mockSubmit; });
      act(() => result.current.setFormDirty(true));
      act(() => { result.current.modalProps.onBeforeClose(); });

      act(() => result.current.unsavedChangesDialog.onSave());

      expect(result.current.unsavedChangesDialog.isOpen).toBe(false);
      expect(mockSubmit).toHaveBeenCalledTimes(1);
    });
  });

  describe('formSubmitRef', () => {
    it('starts as null', () => {
      const { result } = renderHook(() => useFormModal());
      expect(result.current.formSubmitRef.current).toBeNull();
    });

    it('is cleared on close', () => {
      const { result } = renderHook(() => useFormModal());
      act(() => result.current.openCreate());
      act(() => { result.current.formSubmitRef.current = () => {}; });
      act(() => result.current.close());
      expect(result.current.formSubmitRef.current).toBeNull();
    });
  });
});
