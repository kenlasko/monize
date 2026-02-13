import { forwardRef, InputHTMLAttributes } from 'react';
import { cn, inputBaseClasses, inputErrorClasses } from '@/lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  prefix?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, prefix, className, id, type, value, ...props }, ref) => {
    const inputId = id || `input-${label?.toLowerCase().replace(/\s+/g, '-')}`;
    const isEmptyDate = type === 'date' && value !== undefined && !value;

    return (
      <div className="w-full">
        {label && (
          <label
            htmlFor={inputId}
            className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
          >
            {label}
          </label>
        )}
        <div className={prefix ? 'relative' : undefined}>
          {prefix && (
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-gray-500 dark:text-gray-400 pointer-events-none">
              {prefix}
            </span>
          )}
          <input
            ref={ref}
            id={inputId}
            type={type}
            value={value}
            className={cn(
              inputBaseClasses,
              'border px-3 py-2 focus:ring-1 focus:outline-none',
              error && inputErrorClasses,
              prefix && 'pl-7',
              isEmptyDate && 'date-empty',
              className
            )}
            {...props}
          />
        </div>
        {error && (
          <p className="mt-1 text-sm text-red-600 dark:text-red-400">{error}</p>
        )}
      </div>
    );
  }
);

Input.displayName = 'Input';
