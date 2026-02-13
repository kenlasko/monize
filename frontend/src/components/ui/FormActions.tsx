import { Button } from './Button';
import { cn } from '@/lib/utils';

interface FormActionsProps {
  onCancel?: () => void;
  submitLabel?: string;
  isSubmitting?: boolean;
  className?: string;
}

/**
 * Standardized Cancel + Submit button row for form modals.
 */
export function FormActions({
  onCancel,
  submitLabel = 'Save',
  isSubmitting = false,
  className,
}: FormActionsProps) {
  return (
    <div className={cn('flex justify-end space-x-3 pt-4', className)}>
      {onCancel && (
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
      )}
      <Button type="submit" isLoading={isSubmitting}>
        {submitLabel}
      </Button>
    </div>
  );
}
