'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { useClickOutside } from '@/hooks/useClickOutside';
import { Modal } from '@/components/ui/Modal';
import {
  CurrencyInfo,
  CreateCurrencyData,
  exchangeRatesApi,
} from '@/lib/exchange-rates';
import { getCurrencySymbol } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import { getErrorCode, getErrorMessage } from '@/lib/errors';

const CurrencyForm = dynamic(
  () => import('@/components/currencies/CurrencyForm').then((m) => m.CurrencyForm),
  { ssr: false },
);

const logger = createLogger('CurrencyPickerButton');
const POPOVER_WIDTH = 300;

interface CurrencyPickerButtonProps {
  /** Currently selected entry currency code. Empty string means the account currency. */
  value: string;
  /** The account's own currency, always offered as the first ("account currency") row. */
  accountCurrencyCode: string;
  /** Called with the chosen code ('' when the account currency row is picked). */
  onChange: (code: string) => void;
  disabled?: boolean;
  /** Optional attributes (e.g. a guided-tour data-tour-id) spread onto the button. */
  anchorProps?: { 'data-tour-id'?: string };
}

/**
 * Square button, placed left of the Amount input, showing the symbol of the
 * currency the amount is being entered in. Clicking it opens an anchored
 * popover listing the user's active currencies (plus an "Add currency..." row
 * that opens the existing CurrencyForm in a modal). Mirrors the history/Split
 * button pattern in NormalTransactionFields and the anchored-popover pattern in
 * RecentTransactionsPopover.
 */
export function CurrencyPickerButton({
  value,
  accountCurrencyCode,
  onChange,
  disabled,
  anchorProps,
}: CurrencyPickerButtonProps) {
  const t = useTranslations('transactions');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);

  // Symbol shown on the button follows the effective entry currency.
  const effectiveCode = value || accountCurrencyCode;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        {...anchorProps}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-label={t('form.currencyPicker.ariaLabel')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('form.currencyPicker.label')}
        className="flex-shrink-0 mt-6 flex items-center justify-center px-2.5 min-w-[2.75rem] border border-gray-300 dark:border-gray-600 rounded-md text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 dark:focus:ring-offset-gray-900 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <span className="text-sm font-medium">
          {getCurrencySymbol(effectiveCode)}
        </span>
      </button>
      {open && (
        <CurrencyPickerPopover
          anchorRef={buttonRef}
          value={value}
          accountCurrencyCode={accountCurrencyCode}
          onSelect={(code) => {
            onChange(code);
            setOpen(false);
          }}
          onAddCurrency={() => {
            setOpen(false);
            setShowAddModal(true);
          }}
          onClose={() => setOpen(false)}
        />
      )}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        maxWidth="lg"
        className="p-6"
        pushHistory
      >
        <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
          {t('form.currencyPicker.addCurrency')}
        </h2>
        <CurrencyForm
          onSubmit={async (data: CreateCurrencyData) => {
            try {
              const created = await exchangeRatesApi.createCurrency(data);
              setShowAddModal(false);
              // Select the newly created currency for entry.
              onChange(created.code);
            } catch (error) {
              // The inactive case is handled inline by CurrencyForm (it shows a
              // reactivation note), so only toast other failures here.
              if (getErrorCode(error) !== 'CURRENCY_INACTIVE') {
                toast.error(getErrorMessage(error, t('form.currencyPicker.createFailed')));
              }
              throw error;
            }
          }}
          onReactivate={async (code: string) => {
            const activated = await exchangeRatesApi.activateCurrency(code);
            setShowAddModal(false);
            onChange(activated.code);
            toast.success(t('form.currencyPicker.reactivated', { code: activated.code }));
          }}
          onCancel={() => setShowAddModal(false)}
        />
      </Modal>
    </>
  );
}

interface CurrencyPickerPopoverProps {
  anchorRef: React.RefObject<HTMLElement | null>;
  value: string;
  accountCurrencyCode: string;
  onSelect: (code: string) => void;
  onAddCurrency: () => void;
  onClose: () => void;
}

function CurrencyPickerPopover({
  anchorRef,
  value,
  accountCurrencyCode,
  onSelect,
  onAddCurrency,
  onClose,
}: CurrencyPickerPopoverProps) {
  const t = useTranslations('transactions');
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    let left = rect.left;
    if (left + POPOVER_WIDTH > window.innerWidth - 8) {
      left = window.innerWidth - POPOVER_WIDTH - 8;
    }
    if (left < 8) left = 8;
    setPosition({ top: rect.bottom + 4, left });
  }, [anchorRef]);

  useEffect(() => {
    let cancelled = false;
    exchangeRatesApi
      .getCurrencies()
      .then((rows) => {
        if (cancelled) return;
        setCurrencies(rows.filter((c) => c.isActive));
        setIsLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        logger.warn('Failed to load currencies', err);
        toast.error(t('form.toasts.loadFailed'));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  useClickOutside([popoverRef, anchorRef], onClose, { onEscape: onClose });

  if (!position) return null;

  // Account currency first, then any other active currencies (excluding the
  // account currency, which is already offered as the first row).
  const others = currencies.filter(
    (c) => c.code.toUpperCase() !== accountCurrencyCode.toUpperCase(),
  );

  const rowClass =
    'w-full text-left px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 focus:bg-gray-50 dark:focus:bg-gray-700 focus:outline-none border-b last:border-b-0 border-gray-100 dark:border-gray-700 text-sm';

  const content = (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={t('form.currencyPicker.title')}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      className="fixed z-50 rounded-md border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg"
    >
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {t('form.currencyPicker.title')}
      </div>
      <div className="max-h-80 overflow-y-auto">
        <button
          type="button"
          onClick={() => onSelect('')}
          className={`${rowClass} ${!value ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
        >
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {t('form.currencyPicker.accountCurrency', { code: accountCurrencyCode })}
          </span>
        </button>
        {isLoading && (
          <div className="px-3 py-4 text-sm text-gray-500 dark:text-gray-400">
            {t('recentPopover.loading')}
          </div>
        )}
        {!isLoading &&
          others.map((c) => (
            <button
              key={c.code}
              type="button"
              onClick={() => onSelect(c.code)}
              className={`${rowClass} ${value === c.code ? 'bg-blue-50 dark:bg-blue-900/30' : ''}`}
            >
              <span className="text-gray-900 dark:text-gray-100">
                {t('form.currencyPicker.optionLabel', {
                  symbol: c.symbol,
                  code: c.code,
                  name: c.name,
                })}
              </span>
            </button>
          ))}
        <button
          type="button"
          onClick={onAddCurrency}
          className={`${rowClass} text-blue-600 dark:text-blue-400 font-medium`}
        >
          {t('form.currencyPicker.addCurrency')}
        </button>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
