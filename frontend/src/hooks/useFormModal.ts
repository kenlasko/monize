import { useState, useCallback, useRef, MutableRefObject } from 'react';

interface UnsavedChangesDialogState {
  isOpen: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

interface UseFormModalReturn<T> {
  /** Whether the form modal is currently open */
  showForm: boolean;
  /** The item being edited, or undefined for new item */
  editingItem: T | undefined;
  /** Open the form for creating a new item */
  openCreate: () => void;
  /** Open the form for editing an existing item */
  openEdit: (item: T) => void;
  /** Close the form and clear the editing item */
  close: () => void;
  /** Whether we're in edit mode (has an editing item) */
  isEditing: boolean;
  /** Props to spread onto the Modal component (pushHistory + onBeforeClose) */
  modalProps: {
    pushHistory: boolean;
    onBeforeClose: () => boolean | void;
  };
  /** Call from the form's onDirtyChange callback to track unsaved changes */
  setFormDirty: (dirty: boolean) => void;
  /** State and handlers for the UnsavedChangesDialog component */
  unsavedChangesDialog: UnsavedChangesDialogState;
  /** Ref that forms populate with their submit function (for Save from unsaved dialog) */
  formSubmitRef: MutableRefObject<(() => void) | null>;
}

/**
 * Hook to manage form modal state for create/edit operations.
 * Includes browser history integration (back button closes modal)
 * and unsaved changes tracking.
 *
 * @example
 * ```tsx
 * const { showForm, editingItem, openCreate, openEdit, close, isEditing,
 *         modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Account>();
 *
 * return (
 *   <>
 *     <Button onClick={openCreate}>+ New Account</Button>
 *     <AccountList onEdit={openEdit} />
 *     <Modal isOpen={showForm} onClose={close} {...modalProps}>
 *       <h2>{isEditing ? 'Edit Account' : 'New Account'}</h2>
 *       <AccountForm account={editingItem} onCancel={close}
 *         onDirtyChange={setFormDirty} submitRef={formSubmitRef} />
 *     </Modal>
 *     <UnsavedChangesDialog {...unsavedChangesDialog} />
 *   </>
 * );
 * ```
 */
export function useFormModal<T>(): UseFormModalReturn<T> {
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<T | undefined>(undefined);
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const isFormDirtyRef = useRef(false);
  const formSubmitRef = useRef<(() => void) | null>(null);

  const openCreate = useCallback(() => {
    setEditingItem(undefined);
    isFormDirtyRef.current = false;
    setShowForm(true);
  }, []);

  const openEdit = useCallback((item: T) => {
    setEditingItem(item);
    isFormDirtyRef.current = false;
    setShowForm(true);
  }, []);

  // Force close — bypasses dirty checking
  const forceClose = useCallback(() => {
    setShowForm(false);
    setEditingItem(undefined);
    isFormDirtyRef.current = false;
    setShowUnsavedDialog(false);
    formSubmitRef.current = null;
  }, []);

  // Normal close — used as onClose for Modal (Modal's onBeforeClose will intercept if dirty)
  const close = useCallback(() => {
    setShowForm(false);
    setEditingItem(undefined);
    isFormDirtyRef.current = false;
    formSubmitRef.current = null;
  }, []);

  const setFormDirty = useCallback((dirty: boolean) => {
    isFormDirtyRef.current = dirty;
  }, []);

  // onBeforeClose — intercepts close attempts when form is dirty
  const onBeforeClose = useCallback(() => {
    if (isFormDirtyRef.current) {
      setShowUnsavedDialog(true);
      return false;
    }
    return undefined;
  }, []);

  const handleUnsavedSave = useCallback(() => {
    setShowUnsavedDialog(false);
    formSubmitRef.current?.();
  }, []);

  const handleUnsavedDiscard = useCallback(() => {
    setShowUnsavedDialog(false);
    isFormDirtyRef.current = false;
    forceClose();
  }, [forceClose]);

  const handleUnsavedCancel = useCallback(() => {
    setShowUnsavedDialog(false);
  }, []);

  return {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing: editingItem !== undefined,
    modalProps: {
      pushHistory: true,
      onBeforeClose,
    },
    setFormDirty,
    unsavedChangesDialog: {
      isOpen: showUnsavedDialog,
      onSave: handleUnsavedSave,
      onDiscard: handleUnsavedDiscard,
      onCancel: handleUnsavedCancel,
    },
    formSubmitRef,
  };
}
