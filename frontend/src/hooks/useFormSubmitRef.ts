import { useEffect, MutableRefObject } from 'react';
import { UseFormHandleSubmit } from 'react-hook-form';

/**
 * Syncs a form's handleSubmit function to an external ref.
 * Used by useFormModal to trigger form submission from outside the form
 * (e.g., from the UnsavedChangesDialog "Save" button).
 */
export function useFormSubmitRef(
  submitRef: MutableRefObject<(() => void) | null> | undefined,
  handleSubmit: UseFormHandleSubmit<any>,
  onSubmit: (...args: any[]) => any
) {
  useEffect(() => {
    if (submitRef) submitRef.current = handleSubmit(onSubmit);
    return () => { if (submitRef) submitRef.current = null; };
  }, [submitRef, handleSubmit, onSubmit]);
}
