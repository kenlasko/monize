import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from './proxy';

const BASE = 'https://monize.laskonet.com';

function makeRequest(
  path: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
  });
}

describe('proxy MCP-at-root routing', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(
      new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('proxies POST / with MCP Accept header to the backend MCP endpoint', async () => {
    const request = makeRequest('/', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
    });
    const response = await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
    expect(response.status).toBe(200);
  });

  it('proxies GET / SSE stream requests to the backend MCP endpoint', async () => {
    const request = makeRequest('/', {
      headers: { accept: 'text/event-stream' },
    });
    await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
  });

  it('proxies DELETE / with an Mcp-Session-Id header to the backend MCP endpoint', async () => {
    const request = makeRequest('/', {
      method: 'DELETE',
      headers: { 'mcp-session-id': 'abc123' },
    });
    await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
  });

  it('does not proxy a browser navigation to / (redirects to login instead)', async () => {
    const request = makeRequest('/', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    const response = await proxy(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${BASE}/login`);
  });

  it('does not proxy /login even when MCP headers are present', async () => {
    const request = makeRequest('/login', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
    });
    const response = await proxy(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.headers.get('location')).toBeNull();
  });

  it('still proxies explicit /api/v1/mcp requests unchanged', async () => {
    const request = makeRequest('/api/v1/mcp', {
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
    });
    await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
  });
});

describe('proxy security headers', () => {
  const originalDisable = process.env.DISABLE_HTTPS_HEADERS;

  afterEach(() => {
    if (originalDisable === undefined) delete process.env.DISABLE_HTTPS_HEADERS;
    else process.env.DISABLE_HTTPS_HEADERS = originalDisable;
    vi.unstubAllGlobals();
  });

  it('sets HSTS and static security headers on the unauthenticated /login redirect', async () => {
    delete process.env.DISABLE_HTTPS_HEADERS;
    const request = makeRequest('/dashboard', {
      headers: { accept: 'text/html' },
    });
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${BASE}/login`);
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin');
  });

  it('omits HSTS on the redirect when DISABLE_HTTPS_HEADERS is set', async () => {
    process.env.DISABLE_HTTPS_HEADERS = 'true';
    const request = makeRequest('/dashboard', {
      headers: { accept: 'text/html' },
    });
    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get('Strict-Transport-Security')).toBeNull();
    expect(response.headers.get('Cross-Origin-Opener-Policy')).toBeNull();
    // Static (non-HTTPS-gated) headers are still present.
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('sets security headers on the 502 backend-unavailable fallback', async () => {
    delete process.env.DISABLE_HTTPS_HEADERS;
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
    vi.stubGlobal('fetch', fetchMock);

    const request = makeRequest('/api/v1/accounts');
    const response = await proxy(request);

    expect(response.status).toBe(502);
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });
});
