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

  it('proxies POST / carrying a bearer token, so the API answers an invalid one', async () => {
    // A security scan aimed at the bare origin sent exactly this: a bearer token
    // and nothing else. It used to match no MCP signal, fall through to the app
    // shell, and be answered 307 -> 200, which reads as "the server accepted an
    // invalid token". The backend has always refused it with a 401; the proxy
    // just has to let that refusal through.
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":{"message":"Unauthorized"}}', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer realm="monize"' },
      }),
    );
    const request = makeRequest('/', {
      method: 'POST',
      headers: {
        authorization: 'Bearer not-a-real-token',
        accept: 'application/json',
        'content-type': 'application/json',
      },
    });
    const response = await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
    expect(response.status).toBe(401);
    expect(response.headers.get('location')).toBeNull();
  });

  it('matches the bearer scheme case-insensitively', async () => {
    const request = makeRequest('/', {
      method: 'POST',
      headers: { authorization: 'bearer pat_lowercase_scheme' },
    });
    await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
  });

  it('proxies POST / with the 2026-07-28 Mcp-Method header', async () => {
    const request = makeRequest('/', {
      method: 'POST',
      headers: { 'mcp-method': 'tools/list', 'mcp-name': 'list_accounts' },
    });
    await proxy(request);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:3001/api/v1/mcp');
  });

  it('still redirects a cookie-authenticated browser navigation to /', async () => {
    // The app authenticates with cookies and never sends Authorization, so
    // widening the predicate cannot reach an ordinary page load.
    const request = makeRequest('/', {
      headers: {
        accept: 'text/html,application/xhtml+xml',
        cookie: 'access_token=abc',
      },
    });
    const response = await proxy(request);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(response.status).toBe(307);
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

  /**
   * The document scanner compiles a WebAssembly build in a worker, and under a
   * nonce policy `WebAssembly.instantiate` is refused without this source --
   * silently, with nothing in the console pointing at the CSP. It permits WASM
   * compilation only; it does not restore `eval()` for JavaScript.
   */
  it('allows WebAssembly compilation in script-src', async () => {
    // A public page, so the response is the app shell itself rather than a
    // redirect -- the CSP is set on what actually renders the scanner.
    const request = makeRequest('/login', { headers: { accept: 'text/html' } });
    const response = await proxy(request);

    const csp = response.headers.get('Content-Security-Policy') ?? '';
    const scriptSrc = csp
      .split(';')
      .map((directive) => directive.trim())
      .find((directive) => directive.startsWith('script-src'));

    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    // The nonce policy it sits beside is unchanged.
    expect(scriptSrc).toContain("'strict-dynamic'");
    expect(scriptSrc).toContain("'self'");
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
