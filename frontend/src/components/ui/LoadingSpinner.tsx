interface LoadingSpinnerProps {
  /** Text to show below the spinner (e.g., "Loading accounts...") */
  text?: string;
  /** Size of the spinner - defaults to 'md' */
  size?: 'sm' | 'md' | 'lg';
  /** Whether to show with full container padding (for page content areas) */
  fullContainer?: boolean;
}

const sizeClasses = {
  sm: 'h-5 w-5',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

export function LoadingSpinner({ text, size = 'md', fullContainer = true }: LoadingSpinnerProps) {
  const spinner = (
    <div className="inline-block animate-spin rounded-full border-b-2 border-blue-600 dark:border-blue-400"
         style={{ width: size === 'sm' ? '1.25rem' : size === 'lg' ? '3rem' : '2rem',
                  height: size === 'sm' ? '1.25rem' : size === 'lg' ? '3rem' : '2rem' }} />
  );

  if (!fullContainer) {
    return (
      <div className="flex items-center gap-2">
        {spinner}
        {text && <span className="text-gray-500 dark:text-gray-400">{text}</span>}
      </div>
    );
  }

  return (
    <div className="p-12 text-center">
      {spinner}
      {text && <p className="mt-2 text-gray-500 dark:text-gray-400">{text}</p>}
    </div>
  );
}
