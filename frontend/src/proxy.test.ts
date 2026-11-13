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

describe('proxy client address forwarding', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    fetchMock.mockReset();
  });

  function forwardedFor(): string | null {
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    return new Headers(init.headers).get('x-forwarded-for');
  }

  // The backend keys every per-IP rate limit on this header. A client that
  // could choose it could reset its own login-attempt counter on every try.
  it('forwards the address the edge appended, never a client-sent one', async () => {
    await proxy(
      makeRequest('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'x-real-ip': '1.1.1.1',
          'x-forwarded-for': '2.2.2.2, 3.3.3.3, 198.51.100.9',
        },
      }),
    );
    expect(forwardedFor()).toBe('198.51.100.9');
  });

  it('honours TRUSTED_PROXY_HOPS and CLIENT_IP_HEADER', async () => {
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    await proxy(
      makeRequest('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'x-forwarded-for': '2.2.2.2, 198.51.100.9, 10.0.0.2' },
      }),
    );
    expect(forwardedFor()).toBe('198.51.100.9');

    fetchMock.mockClear();
    vi.stubEnv('CLIENT_IP_HEADER', 'x-real-ip');
    await proxy(
      makeRequest('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'x-real-ip': '203.0.113.4', 'x-forwarded-for': '10.0.0.2' },
      }),
    );
    expect(forwardedFor()).toBe('203.0.113.4');
  });

  it('forwards no address at all when none was vouched for', async () => {
    await proxy(
      makeRequest('/api/v1/auth/login', {
        method: 'POST',
        headers: { 'x-real-ip': '1.1.1.1' },
      }),
    );
    expect(forwardedFor()).toBeNull();
  });
});

/**
 * An edge that relays an HTTP/3 request of undeclared length (Caddy, for a
 * bodiless PATCH) sends it on over HTTP/1.1 with `Transfer-Encoding: chunked`.
 * undici's fetch refuses that header, and `keep-alive` and `upgrade` with it,
 * before the request leaves, so forwarding them turned the call into a 502.
 */
describe('proxy hop-by-hop headers', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('does not forward connection-level headers to the backend', async () => {
    const response = await proxy(
      makeRequest('/api/v1/ai/insights/i1/dismiss', {
        method: 'PATCH',
        headers: {
          'transfer-encoding': 'chunked',
          'keep-alive': 'timeout=5',
          upgrade: 'h2c',
          'x-csrf-token': 'token',
        },
      }),
    );

    expect(response.status).toBe(204);
    const forwarded = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers);
    expect(forwarded.has('transfer-encoding')).toBe(false);
    expect(forwarded.has('keep-alive')).toBe(false);
    expect(forwarded.has('upgrade')).toBe(false);
    expect(forwarded.get('x-csrf-token')).toBe('token');
  });
});

/**
 * Next copies every matched request's body into memory, up to
 * `proxyClientMaxBodySize`, before this proxy runs. So the proxy's own limit is
 * the backend's default (10 MB), and the routes that need more are kept out of
 * the matcher altogether and streamed by route handlers.
 */
describe('proxy request body limit', () => {
  const fetchMock = vi.fn();
  const MIB = 1024 * 1024;

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function bodyOf(size: number): ReadableStream<Uint8Array> {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= size) return controller.close();
        const chunk = Math.min(MIB, size - sent);
        sent += chunk;
        controller.enqueue(new Uint8Array(chunk));
      },
    });
  }

  function post(path: string, body: ReadableStream<Uint8Array>, headers: Record<string, string> = {}) {
    return new NextRequest(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body,
      duplex: 'half',
    } as ConstructorParameters<typeof NextRequest>[1]);
  }

  it('refuses a declared body over 10 MB with 413, before forwarding', async () => {
    const response = await proxy(
      post('/api/v1/auth/login', bodyOf(1), { 'content-length': String(300 * MIB) }),
    );

    expect(response.status).toBe(413);
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an undeclared body once it passes 10 MB', async () => {
    const response = await proxy(post('/api/v1/auth/login', bodyOf(11 * MIB)));

    expect(response.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards a body within the limit whole', async () => {
    const response = await proxy(post('/api/v1/transactions', bodyOf(2 * MIB)));

    expect(response.status).toBe(200);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.body as Uint8Array).byteLength).toBe(2 * MIB);
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

  it('hands the root layout the pathname it saw, overwriting a client-sent one', async () => {
    const response = await proxy(
      makeRequest('/login', {
        headers: { accept: 'text/html', 'x-pathname': '/dashboard' },
      }),
    );
    // NextResponse.next({ request: { headers } }) forwards each overridden
    // request header under this prefix.
    expect(response.headers.get('x-middleware-request-x-pathname')).toBe('/login');
  });

  /**
   * The detected-locale cookie is not HttpOnly (the language pickers rewrite
   * it from the client), so Secure is what keeps it off plain HTTP. It follows
   * the backend's auth cookies: production, unless HTTPS headers are disabled.
   */
  describe('detected-locale cookie', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    async function localeCookie() {
      const response = await proxy(
        makeRequest('/login', { headers: { accept: 'text/html' } }),
      );
      return response.cookies.get('NEXT_LOCALE');
    }

    it('is Secure in production', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DISABLE_HTTPS_HEADERS', '');
      const cookie = await localeCookie();
      expect(cookie?.secure).toBe(true);
      expect(cookie?.sameSite).toBe('lax');
    });

    it('is not Secure when DISABLE_HTTPS_HEADERS is set', async () => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('DISABLE_HTTPS_HEADERS', 'true');
      expect((await localeCookie())?.secure).toBe(false);
    });

    it('is not Secure outside production', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      vi.stubEnv('DISABLE_HTTPS_HEADERS', '');
      expect((await localeCookie())?.secure).toBe(false);
    });
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

describe('proxy web share target fallback', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  /** A share POST as the OS sends it, with a body the proxy must not touch. */
  function makeShareRequest(): NextRequest {
    const body = new FormData();
    body.append('files', new File(['receipt bytes'], 'receipt.png', { type: 'image/png' }));
    return new NextRequest(`${BASE}/share-target`, { method: 'POST', body });
  }

  // The worker normally answers this POST and the network never sees it. When
  // it does reach us, the one thing that must not happen is the bytes going
  // anywhere: not to the backend, not even read into this process.
  it('answers a missed share with a 303 to the review page', async () => {
    const response = await proxy(makeShareRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`${BASE}/share?missed=1`);
  });

  it('never reads the shared body, and never forwards it to the backend', async () => {
    const request = makeShareRequest();

    await proxy(request);

    expect(request.bodyUsed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // Without this branch the POST falls through to the unauthenticated redirect,
  // which is a 307 -- and a 307 replays the multipart POST against /login.
  it('answers before the auth check, so a signed-out share is not replayed', async () => {
    const response = await proxy(makeShareRequest());

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).not.toContain('/login');
  });

  it('applies the standard security headers to that redirect', async () => {
    delete process.env.DISABLE_HTTPS_HEADERS;
    const response = await proxy(makeShareRequest());

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
  });

  it('leaves a GET of the action path on the ordinary protected path', async () => {
    const response = await proxy(makeRequest('/share-target'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(`${BASE}/login`);
  });

  it('sends a signed-out share review to login carrying the way back', async () => {
    const response = await proxy(makeRequest('/share?id=abc-123'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      `${BASE}/login?returnTo=%2Fshare%3Fid%3Dabc-123`,
    );
  });

  it('leaves every other protected route redirecting to a bare /login', async () => {
    const response = await proxy(makeRequest('/dashboard'));

    expect(response.headers.get('location')).toBe(`${BASE}/login`);
  });
});

/**
 * The behavioural test above proves this request's body is not read. This scan
 * holds the structural reason it cannot be: the share branch returns before the
 * proxy reaches any code that consumes a body. Someone moving that branch below
 * the API block would keep the behaviour only by accident.
 */
describe('proxy.ts share branch placement', () => {
  const proxySource = import.meta.glob('/src/proxy.ts', {
    query: '?raw',
    eager: true,
    import: 'default',
  }) as Record<string, string>;

  /**
   * Blank comments, keeping line numbering, so the scan reads CODE. The comment
   * above the share branch necessarily says "without touching the body", and a
   * scan that its own explanation could satisfy would prove nothing.
   */
  function withoutComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/\/\/[^\n]*/g, (line) => ' '.repeat(line.length));
  }

  const BODY_READ = /request\.(arrayBuffer|formData|text|json|blob)\s*\(|request\.body\b/;

  it('resolved the module, and the stripper works in both directions', () => {
    expect(Object.keys(proxySource)).toEqual(['/src/proxy.ts']);

    const stripped = withoutComments(
      ['// request.arrayBuffer()', '/* request.body */', 'await request.arrayBuffer();'].join('\n'),
    );
    const lines = stripped.split('\n');
    expect(BODY_READ.test(lines[0])).toBe(false);
    expect(BODY_READ.test(lines[1])).toBe(false);
    expect(BODY_READ.test(lines[2])).toBe(true);
    expect(lines).toHaveLength(3);
  });

  it('returns the share redirect before any code that consumes a body', () => {
    const code = withoutComments(proxySource['/src/proxy.ts']);

    const shareBranch = code.indexOf('SHARE_TARGET_PATH');
    const firstBodyRead = code.search(BODY_READ);

    expect(shareBranch).toBeGreaterThan(-1);
    expect(firstBodyRead).toBeGreaterThan(-1);
    expect(shareBranch).toBeLessThan(firstBodyRead);
  });
});

describe('proxy Server Action refusal', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it('answers a POST naming a Server Action with 404 and the not-found marker', async () => {
    const response = await proxy(
      makeRequest('/dashboard', {
        method: 'POST',
        headers: { 'next-action': 'x', cookie: 'auth_token=abc' },
      }),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get('x-nextjs-action-not-found')).toBe('1');
    expect(response.headers.get('x-middleware-next')).toBeNull();
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });

  it('refuses one on a public path and at the root, never forwarding it', async () => {
    for (const path of ['/', '/login']) {
      const response = await proxy(
        makeRequest(path, { method: 'POST', headers: { 'Next-Action': '7f00' } }),
      );
      expect(response.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves a GET carrying the header on its ordinary path', async () => {
    const response = await proxy(
      makeRequest('/login', { headers: { 'next-action': 'x' } }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('holds while the app defines no Server Action', () => {
    const sources = import.meta.glob(
      ['/src/**/*.{ts,tsx}', '!/src/**/*.test.{ts,tsx}'],
      { query: '?raw', eager: true, import: 'default' },
    ) as Record<string, string>;
    const directive = /^\s*['"]use server['"]/m;

    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(Object.keys(sources).filter((file) => directive.test(sources[file]))).toEqual([]);
  });
});
