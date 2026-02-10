import { describe, it, expect } from 'vitest';
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
});
