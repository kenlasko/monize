'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';

interface NewTransactionButtonProps {
  onNewInvestment: () => void;
  onNewCash: () => void;
}

const menuItemClass =
  'w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700';

export function NewTransactionButton({ onNewInvestment, onNewCash }: NewTransactionButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        close();
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        close();
        triggerRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, close]);

  const handleInvestment = () => {
    close();
    onNewInvestment();
  };

  const handleCash = () => {
    close();
    onNewCash();
  };

  return (
    <div ref={dropdownRef} className="relative block w-full sm:inline-block sm:w-auto">
      <Button
        ref={triggerRef}
        onClick={() => setIsOpen((open) => !open)}
        className="w-full whitespace-nowrap sm:w-auto"
        aria-haspopup="true"
        aria-expanded={isOpen}
      >
        + New Transaction
        <svg className="ml-1.5 h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </Button>

      {isOpen && (
        <div className="absolute right-0 mt-1 w-full sm:w-56 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50">
          <button onClick={handleInvestment} className={`${menuItemClass} rounded-t-md`}>
            Investment Transaction
          </button>
          <button onClick={handleCash} className={`${menuItemClass} rounded-b-md`}>
            Cash Transaction
          </button>
        </div>
      )}
    </div>
  );
}
