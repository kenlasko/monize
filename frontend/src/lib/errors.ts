import { AxiosError } from 'axios';
import toast from 'react-hot-toast';

/**
 * Shows an error toast unless the error is a 502 / network error (handled by BackendDownBanner).
 */
export function showErrorToast(error: unknown, fallback: string): void {
  if (error instanceof AxiosError && (error.response?.status === 502 || !error.response)) {
    return;
  }
  toast.error(getErrorMessage(error, fallback));
}

/**
 * Extracts the machine-readable `errorCode` the backend attaches to some
 * failures (e.g. "CURRENCY_INACTIVE"), so callers can branch on the specific
 * case without parsing the localized message. Returns undefined when absent.
 */
export function getErrorCode(error: unknown): string | undefined {
  if (error instanceof AxiosError) {
    const code = error.response?.data?.errorCode;
    return typeof code === 'string' ? code : undefined;
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as Record<string, unknown>).response === 'object'
  ) {
    const response = (error as { response: { data?: { errorCode?: unknown } } }).response;
    const code = response?.data?.errorCode;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

/**
 * A response body's `message` as one string. A DTO refusal (the validation
 * pipe) answers it as a list of sentences, so a list is joined; anything else
 * that is not a non-empty string is the fallback.
 */
function responseMessage(message: unknown, fallback: string): string {
  if (typeof message === 'string') return message || fallback;
  if (Array.isArray(message)) {
    const sentences = message.filter((item): item is string => typeof item === 'string' && item !== '');
    return sentences.length > 0 ? sentences.join('. ') : fallback;
  }
  return fallback;
}

/**
 * Extracts a user-friendly error message from an error caught in a try/catch block.
 * Handles Axios errors (with server response messages) and generic Error objects.
 * Always a string, even for a DTO refusal whose `message` is a list.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof AxiosError) {
    return responseMessage(error.response?.data?.message, fallback);
  }
  if (
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as Record<string, unknown>).response === 'object'
  ) {
    const response = (error as { response: { data?: { message?: unknown } } }).response;
    return responseMessage(response?.data?.message, fallback);
  }
  if (error instanceof Error) {
    return error.message || fallback;
  }
  return fallback;
}
