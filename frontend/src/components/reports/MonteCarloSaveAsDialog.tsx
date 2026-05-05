'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

interface MonteCarloSaveAsDialogProps {
  isOpen: boolean;
  initialName: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

export function MonteCarloSaveAsDialog({
  isOpen,
  initialName,
  onCancel,
  onSubmit,
}: MonteCarloSaveAsDialogProps) {
  const [name, setName] = useState(initialName);

  useEffect(() => {
    if (isOpen) setName(initialName);
  }, [isOpen, initialName]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    onSubmit(trimmed.slice(0, 255));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="md"
      className="p-6"
      pushHistory
    >
      <form onSubmit={handleSubmit}>
        <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
          Save scenario as
        </h3>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
          Enter a name for this scenario. Keep the existing name to overwrite.
        </p>
        <label
          htmlFor="mc-save-as-name"
          className="block mt-4 text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Name
        </label>
        <input
          id="mc-save-as-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={255}
          autoFocus
          className="mt-1 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim()}>
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}
