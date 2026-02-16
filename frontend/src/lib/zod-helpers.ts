import '@/lib/zodConfig';
import { z } from 'zod';

/** Convert empty strings to undefined for optional UUID fields */
export const optionalUuid = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().uuid().optional()
);

/** Convert empty strings to undefined for optional string fields */
export const optionalString = z.preprocess(
  (val) => (val === '' ? undefined : val),
  z.string().optional()
);

/** Convert empty strings/null/undefined to undefined for optional number fields */
export const optionalNumber = z.preprocess(
  (val) => (val === '' || val === undefined || val === null ? undefined : val),
  z.number().optional()
);
