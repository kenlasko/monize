import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@/test/render';
import { isHttpsUrl, useStartEmailReceiptOAuth } from './useStartEmailReceiptOAuth';

const api = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/lib/email-receipts-api', () => ({ emailReceiptsApi: { oauth: api } }));

const assign = vi.fn();
const originalLocation = window.location;

describe('isHttpsUrl', () => {
  it('accepts only an https address', () => {
    expect(isHttpsUrl('https://accounts.google.com/o/oauth2/v2/auth?x=1')).toBe(true);
    expect(isHttpsUrl('http://accounts.google.com')).toBe(false);
    expect(isHttpsUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpsUrl('not a url')).toBe(false);
    expect(isHttpsUrl('')).toBe(false);
  });
});

describe('useStartEmailReceiptOAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('asks the server for the consent URL and sends the browser there', async () => {
    api.start.mockResolvedValue({ authorizationUrl: 'https://accounts.google.com/auth?state=s' });
    const { result } = renderHook(() => useStartEmailReceiptOAuth());
    await act(async () => {
      await result.current.start('google');
    });
    expect(api.start).toHaveBeenCalledWith('google');
    expect(assign).toHaveBeenCalledWith('https://accounts.google.com/auth?state=s');
    // The page is leaving, so a second click must not start a second flow.
    expect(result.current.pending).toBe('google');
    expect(result.current.error).toBeNull();
  });

  it('refuses an address that is not https and does not navigate', async () => {
    api.start.mockResolvedValue({ authorizationUrl: 'javascript:alert(1)' });
    const { result } = renderHook(() => useStartEmailReceiptOAuth());
    await act(async () => {
      await result.current.start('microsoft');
    });
    expect(assign).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toMatch(/not a secure web page/);
  });

  it('names the server failure and lets the user try again', async () => {
    api.start.mockRejectedValue({ response: { data: { message: 'Microsoft sign-in is not configured' } } });
    const { result } = renderHook(() => useStartEmailReceiptOAuth());
    await act(async () => {
      await result.current.start('microsoft');
    });
    expect(assign).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    expect(result.current.error).toBe('Microsoft sign-in is not configured');
  });
});
