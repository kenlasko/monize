import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import toast from 'react-hot-toast';
import { showErrorToast, getErrorMessage, getErrorCode } from './errors';

describe('showErrorToast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('suppresses toast on 502 AxiosError', () => {
    const error = new AxiosError('Bad Gateway', '502', undefined, undefined, {
      status: 502,
      data: { error: 'Backend unavailable' },
      statusText: 'Bad Gateway',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    showErrorToast(error, 'Something failed');

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('suppresses toast on network error (no response)', () => {
    const error = new AxiosError('Network Error');
    // Network errors have no response property

    showErrorToast(error, 'Something failed');

    expect(toast.error).not.toHaveBeenCalled();
  });

  it('shows toast for non-502 AxiosError', () => {
    const error = new AxiosError('Not Found', '404', undefined, undefined, {
      status: 404,
      data: { message: 'Resource not found' },
      statusText: 'Not Found',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    showErrorToast(error, 'Fallback message');

    expect(toast.error).toHaveBeenCalledWith('Resource not found');
  });

  it('shows toast with fallback for AxiosError without server message', () => {
    const error = new AxiosError('Server Error', '500', undefined, undefined, {
      status: 500,
      data: {},
      statusText: 'Internal Server Error',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    showErrorToast(error, 'Something went wrong');

    expect(toast.error).toHaveBeenCalledWith('Something went wrong');
  });

  it('shows toast for generic Error', () => {
    const error = new Error('Unexpected failure');

    showErrorToast(error, 'Fallback');

    expect(toast.error).toHaveBeenCalledWith('Unexpected failure');
  });

  it('shows toast with fallback for unknown error types', () => {
    showErrorToast('string error', 'Fallback message');

    expect(toast.error).toHaveBeenCalledWith('Fallback message');
  });
});

describe('getErrorMessage', () => {
  it('extracts message from AxiosError response', () => {
    const error = new AxiosError('Bad Request', '400', undefined, undefined, {
      status: 400,
      data: { message: 'Validation failed' },
      statusText: 'Bad Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    expect(getErrorMessage(error, 'Fallback')).toBe('Validation failed');
  });

  it('joins a DTO refusal whose message is a list into one string', () => {
    const error = new AxiosError('Bad Request', '400', undefined, undefined, {
      status: 400,
      data: { message: ['name must be shorter', 'each value of fromDomains must be a host name'] },
      statusText: 'Bad Request',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    expect(getErrorMessage(error, 'Fallback')).toBe('name must be shorter. each value of fromDomains must be a host name');
  });

  it('returns fallback when the message is an empty list or not text', () => {
    const withMessage = (message: unknown) =>
      new AxiosError('Bad Request', '400', undefined, undefined, {
        status: 400,
        data: { message },
        statusText: 'Bad Request',
        headers: {},
        config: { headers: new AxiosHeaders() },
      });

    expect(getErrorMessage(withMessage([]), 'Fallback')).toBe('Fallback');
    expect(getErrorMessage(withMessage({ nested: true }), 'Fallback')).toBe('Fallback');
  });

  it('returns fallback when AxiosError has no message in response', () => {
    const error = new AxiosError('Server Error', '500', undefined, undefined, {
      status: 500,
      data: {},
      statusText: 'Internal Server Error',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });

    expect(getErrorMessage(error, 'Fallback')).toBe('Fallback');
  });

  it('extracts message from generic Error', () => {
    expect(getErrorMessage(new Error('Something broke'), 'Fallback')).toBe('Something broke');
  });

  it('returns fallback for unknown error types', () => {
    expect(getErrorMessage(42, 'Fallback')).toBe('Fallback');
    expect(getErrorMessage(null, 'Fallback')).toBe('Fallback');
  });
});

describe('getErrorCode', () => {
  it('extracts errorCode from an AxiosError response', () => {
    const error = new AxiosError('Conflict', '409', undefined, undefined, {
      status: 409,
      data: { message: 'Inactive', errorCode: 'CURRENCY_INACTIVE' },
      statusText: 'Conflict',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    expect(getErrorCode(error)).toBe('CURRENCY_INACTIVE');
  });

  it('extracts errorCode from a plain object with a response', () => {
    const error = { response: { data: { errorCode: 'CURRENCY_INACTIVE' } } };
    expect(getErrorCode(error)).toBe('CURRENCY_INACTIVE');
  });

  it('returns undefined when there is no errorCode', () => {
    const error = new AxiosError('Conflict', '409', undefined, undefined, {
      status: 409,
      data: { message: 'Already exists' },
      statusText: 'Conflict',
      headers: {},
      config: { headers: new AxiosHeaders() },
    });
    expect(getErrorCode(error)).toBeUndefined();
  });

  it('returns undefined for unknown error types', () => {
    expect(getErrorCode(42)).toBeUndefined();
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(new Error('boom'))).toBeUndefined();
  });
});
