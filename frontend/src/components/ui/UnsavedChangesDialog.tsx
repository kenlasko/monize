'use client';

import { Button } from './Button';
import { Modal } from './Modal';

interface UnsavedChangesDialogProps {
  isOpen: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function UnsavedChangesDialog({
  isOpen,
  onSave,
  onDiscard,
  onCancel,
}: UnsavedChangesDialogProps) {
  return (
    <Modal isOpen={isOpen} onClose={onCancel} maxWidth="md" className="p-6">
      <div className="flex items-start">
        <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full text-yellow-600 dark:text-yellow-400 bg-yellow-100 dark:bg-yellow-900">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <div className="ml-4">
          <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
            Unsaved Changes
          </h3>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
            You have unsaved changes. What would you like to do?
          </p>
        </div>
      </div>
      <div className="mt-6 flex justify-end space-x-3">
        <Button variant="outline" onClick={onDiscard}>
          Discard
        </Button>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <button
          onClick={onSave}
          className="inline-flex justify-center px-4 py-2 text-sm font-medium text-white border border-transparent rounded-md bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 dark:bg-blue-700 dark:hover:bg-blue-600 dark:focus:ring-offset-gray-800"
        >
          Save
        </button>
      </div>
    </Modal>
  );
}
