import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@/test/render';
import { useImportPreviewSelection } from './useImportPreviewSelection';

const KEYS = ['ref:a', 'ref:b', 'ref:c'];

describe('useImportPreviewSelection', () => {
  it('starts with every row checked and nothing to skip or except', () => {
    const { result } = renderHook(() => useImportPreviewSelection());
    expect(result.current.isChecked('ref:a')).toBe(true);
    expect(result.current.stateOf(KEYS)).toBe('all');
    expect(result.current.selectionFor(KEYS)).toEqual({ importKeys: KEYS, excludeKeys: [], skipCount: 0 });
  });

  it('unchecks a row, which is then skipped for now', () => {
    const { result } = renderHook(() => useImportPreviewSelection());
    act(() => result.current.setChecked('ref:b', false));
    expect(result.current.isChecked('ref:b')).toBe(false);
    expect(result.current.choiceOf('ref:b')).toBe('skip');
    expect(result.current.stateOf(KEYS)).toBe('some');
    expect(result.current.selectionFor(KEYS)).toEqual({
      importKeys: ['ref:a', 'ref:c'],
      excludeKeys: [],
      skipCount: 1,
    });
  });

  it('adds an unchecked row to the exceptions, and checking it again forgets that', () => {
    const { result } = renderHook(() => useImportPreviewSelection());
    act(() => result.current.setChecked('ref:b', false));
    act(() => result.current.setChoice('ref:b', 'except'));
    expect(result.current.selectionFor(KEYS).excludeKeys).toEqual(['ref:b']);
    act(() => result.current.setChecked('ref:b', true));
    act(() => result.current.setChecked('ref:b', false));
    expect(result.current.choiceOf('ref:b')).toBe('skip');
  });

  it('checks or unchecks a whole list at once', () => {
    const { result } = renderHook(() => useImportPreviewSelection());
    act(() => result.current.setAllChecked(KEYS, false));
    expect(result.current.stateOf(KEYS)).toBe('none');
    expect(result.current.selectionFor(KEYS)).toEqual({ importKeys: [], excludeKeys: [], skipCount: 3 });
    act(() => result.current.setAllChecked(KEYS, true));
    expect(result.current.stateOf(KEYS)).toBe('all');
  });

  it('forgets the choices about keys that are no longer offered', () => {
    const { result } = renderHook(() => useImportPreviewSelection());
    act(() => result.current.setAllChecked(KEYS, false));
    act(() => result.current.prune(['ref:a']));
    expect([...result.current.choices.keys()]).toEqual(['ref:a']);
    expect(result.current.isChecked('ref:b')).toBe(true);
  });

  it('hands back stable functions, so an effect that depends on one runs once', () => {
    const { result, rerender } = renderHook(() => useImportPreviewSelection());
    const { prune, setChecked, setChoice, setAllChecked } = result.current;
    act(() => result.current.setChecked('ref:a', false));
    rerender();
    expect(result.current.prune).toBe(prune);
    expect(result.current.setChecked).toBe(setChecked);
    expect(result.current.setChoice).toBe(setChoice);
    expect(result.current.setAllChecked).toBe(setAllChecked);
  });
});
