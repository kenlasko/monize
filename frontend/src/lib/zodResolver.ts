import { FieldErrors, FieldValues, Resolver } from 'react-hook-form';
import { ZodError, ZodType } from 'zod';

/**
 * Custom Zod resolver for react-hook-form that properly handles Zod v4 errors.
 *
 * The standard @hookform/resolvers zodResolver has compatibility issues with Zod v4
 * where errors are thrown instead of being captured. This wrapper catches ZodError
 * and converts it to the format react-hook-form expects.
 *
 * @see https://github.com/react-hook-form/react-hook-form/issues/12816
 */
export function zodResolver<TFieldValues extends FieldValues>(
  schema: ZodType<TFieldValues>
): Resolver<TFieldValues> {
  return async (values) => {
    try {
      const result = await schema.parseAsync(values);
      return {
        values: result as TFieldValues,
        errors: {},
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const errors: FieldErrors<TFieldValues> = {};

        for (const issue of error.issues) {
          const path = issue.path.join('.');
          if (path && !errors[path as keyof TFieldValues]) {
            (errors as Record<string, unknown>)[path] = {
              type: issue.code,
              message: issue.message,
            };
          }
        }

        return {
          values: {},
          errors,
        };
      }

      // Re-throw non-Zod errors
      throw error;
    }
  };
}
