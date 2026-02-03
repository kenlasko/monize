import { useState, useCallback } from 'react';

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
}

/**
 * Hook to manage form modal state for create/edit operations.
 * Eliminates duplicate state management code across pages.
 *
 * @example
 * ```tsx
 * const { showForm, editingItem, openCreate, openEdit, close, isEditing } = useFormModal<Account>();
 *
 * return (
 *   <>
 *     <Button onClick={openCreate}>+ New Account</Button>
 *     <AccountList onEdit={openEdit} />
 *     <Modal isOpen={showForm} onClose={close}>
 *       <h2>{isEditing ? 'Edit Account' : 'New Account'}</h2>
 *       <AccountForm account={editingItem} onCancel={close} />
 *     </Modal>
 *   </>
 * );
 * ```
 */
export function useFormModal<T>(): UseFormModalReturn<T> {
  const [showForm, setShowForm] = useState(false);
  const [editingItem, setEditingItem] = useState<T | undefined>(undefined);

  const openCreate = useCallback(() => {
    setEditingItem(undefined);
    setShowForm(true);
  }, []);

  const openEdit = useCallback((item: T) => {
    setEditingItem(item);
    setShowForm(true);
  }, []);

  const close = useCallback(() => {
    setShowForm(false);
    setEditingItem(undefined);
  }, []);

  return {
    showForm,
    editingItem,
    openCreate,
    openEdit,
    close,
    isEditing: editingItem !== undefined,
  };
}
