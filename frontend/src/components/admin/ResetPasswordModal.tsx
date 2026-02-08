'use client';

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import toast from 'react-hot-toast';

interface ResetPasswordModalProps {
  isOpen: boolean;
  temporaryPassword: string;
  userName: string;
  onClose: () => void;
}

export function ResetPasswordModal({
  isOpen,
  temporaryPassword,
  userName,
  onClose,
}: ResetPasswordModalProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setCopied(true);
      toast.success('Password copied to clipboard');
      setTimeout(() => setCopied(false), 3000);
    } catch {
      toast.error('Failed to copy to clipboard');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="md" className="p-6">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
        Password Reset Successful
      </h3>

      <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
        A temporary password has been set for <strong>{userName}</strong>.
      </p>

      <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">Temporary Password</p>
        <div className="flex items-center justify-between gap-3">
          <code className="text-xl font-mono font-bold text-gray-900 dark:text-gray-100 select-all">
            {temporaryPassword}
          </code>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      <div className="space-y-2 mb-6">
        <p className="text-sm text-amber-600 dark:text-amber-400 font-medium">
          This password will not be shown again.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          The user will be required to change their password on next login.
        </p>
      </div>

      <div className="flex justify-end">
        <Button onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
