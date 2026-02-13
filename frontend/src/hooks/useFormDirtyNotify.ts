import { useEffect } from 'react';

/**
 * Notifies a parent component when a form's dirty state changes.
 * Used with useFormModal's setFormDirty to track unsaved changes.
 */
export function useFormDirtyNotify(
  isDirty: boolean,
  onDirtyChange?: (dirty: boolean) => void
) {
  useEffect(() => { onDirtyChange?.(isDirty); }, [isDirty, onDirtyChange]);
}
