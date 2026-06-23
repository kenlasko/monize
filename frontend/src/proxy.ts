import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE,
  LOCALE_HEADER,
  isSupportedLocale,
  matchAcceptLanguage,
} from '@/i18n/config';

const logger = createLogger('Proxy');
const publicPaths = ['/login', '/register', '/auth/callback', '/forgot-password', '/reset-password', '/verify-email', '/emergency-access/claim'];
let backendConnected = false;

function resolveRequestLocale(request: NextRequest): { locale: string; fromCookie: boolean } {
  const cookieValue = request.cookies.get(LOCALE_COOKIE)?.value;
  if (cookieValue && isSupportedLocale(cookieValue)) {
    return { locale: cookieValue, fromCookie: true };
  }
  const fromAccept = matchAcceptLanguage(request.headers.get('accept-language'));
  return { locale: fromAccept || DEFAULT_LOCALE, fromCookie: false };
}

// Security headers that mirror next.config.js. Next's `headers()` config is
// only applied to responses Next renders (via NextResponse.next()); responses
// the middleware returns directly -- the unauthenticated redirect to /login and
// the 502 backend-unavailable fallback -- bypass it, so a scanner hitting the
// site root sees a redirect with no HSTS. Applying the same set here keeps every
// middleware-generated response consistent with the framework-rendered ones.
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

// HTTPS-only headers, gated by DISABLE_HTTPS_HEADERS for plain-HTTP deployments
// (mirrors next.config.js and the backend Helmet config).
const HTTPS_SECURITY_HEADERS: Record<string, string> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  if (process.env.DISABLE_HTTPS_HEADERS !== 'true') {
    for (const [key, value] of Object.entries(HTTPS_SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

function nextWithCsp(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildCspHeader(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  if (process.env.DISABLE_HTTPS_HEADERS !== 'true') {
    requestHeaders.set('x-https-headers-active', 'true');
  }

  const { locale, fromCookie } = resolveRequestLocale(request);
  requestHeaders.set(LOCALE_HEADER, locale);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  if (!fromCookie) {
    // Persist the detected locale so subsequent requests are deterministic
    // and the backend (nestjs-i18n CookieResolver) sees the same value.
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: '/',
      sameSite: 'lax',
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return response;
}

// MCP clients configured with the bare origin (https://monize.laskonet.com)
// send their JSON-RPC traffic to "/". The Streamable HTTP transport requires
// clients to send "Accept: application/json, text/event-stream" on POST and
// "Accept: text/event-stream" on GET, and follow-up requests carry an
// Mcp-Session-Id / MCP-Protocol-Version header — none of which a browser
// navigation ever sends, so this cannot intercept normal page loads.
function isRootMcpRequest(request: NextRequest, pathname: string): boolean {
  if (pathname !== '/') return false;
  const accept = request.headers.get('accept') ?? '';
  return (
    accept.includes('text/event-stream') ||
    request.headers.has('mcp-session-id') ||
    request.headers.has('mcp-protocol-version')
  );
}

// OAuth 2.1 endpoints exposed at the application root for the MCP remote
// connector flow. These live outside /api because OAuth issuer URLs and the
// RFC 9728 protected-resource metadata path are fixed by the spec; clients
// (Claude Desktop, mcp-remote, etc.) probe them at exact, well-known URLs.
function isOAuthPath(pathname: string): boolean {
  return (
    pathname === '/oauth' ||
    pathname.startsWith('/oauth/') ||
    pathname.startsWith('/oauth-consent/') ||
    pathname === '/.well-known/oauth-protected-resource' ||
    pathname === '/.well-known/oauth-authorization-server' ||
    pathname.startsWith('/.well-known/oauth-authorization-server/') ||
    pathname === '/.well-known/openid-configuration'
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let Next.js API routes handle health checks directly (no proxy)
  if (pathname.startsWith('/api/v1/health/')) {
    return NextResponse.next();
  }

  // Handle API proxying to backend
  const rootMcp = isRootMcpRequest(request, pathname);
  if (pathname.startsWith('/api/') || isOAuthPath(pathname) || rootMcp) {
    const apiUrl = process.env.INTERNAL_API_URL || 'http://localhost:3001';
    const backendPath = rootMcp ? '/api/v1/mcp' : pathname;
    const url = new URL(backendPath + request.nextUrl.search, apiUrl);
    logger.debug(`${request.method} ${pathname} -> ${apiUrl}`);

    const headers = new Headers(request.headers);
    headers.delete('host');
    // Overwrite X-Forwarded-For with the actual connecting client IP
    // to prevent spoofing via client-supplied headers
    const clientIp = request.headers.get('x-real-ip') || '127.0.0.1';
    headers.set('x-forwarded-for', clientIp);
    // Forward resolved locale so the backend nestjs-i18n HeaderResolver picks
    // it up and renders error messages / email content in the right language.
    headers.set(LOCALE_HEADER, resolveRequestLocale(request).locale);

    try {
      // Buffer the body to avoid ReadableStream locking issues in Next.js middleware.
      // Passing request.body (a ReadableStream) directly to undici can intermittently
      // fail with "expected non-null body source" if the stream has already been
      // transferred or locked by the Next.js runtime before the proxy reads it.
      const body =
        request.method !== 'GET' && request.method !== 'HEAD'
          ? await request.arrayBuffer()
          : undefined;

      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body,
        redirect: 'manual',
      });

      if (!backendConnected) {
        backendConnected = true;
        logger.info(`Backend connected at ${apiUrl}`);
      }

      const responseHeaders = new Headers(response.headers);
      responseHeaders.delete('transfer-encoding');

      return new NextResponse(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      logger.error('API proxy error:', error);
      return applySecurityHeaders(
        NextResponse.json({ error: 'Backend unavailable' }, { status: 502 }),
      );
    }
  }

  // Handle auth redirects for non-API routes
  // Check for either access token or refresh token (access token expires in 15m,
  // but refresh token lasts 7 days — if present, the frontend will refresh transparently)
  const token = request.cookies.get('auth_token')?.value || request.cookies.get('refresh_token')?.value;

  // Allow public paths - don't redirect auth pages to dashboard based on cookie alone,
  // as the cookie may reference a deleted/inactive user. Let the client handle redirects.
  if (publicPaths.some(path => pathname.startsWith(path))) {
    return nextWithCsp(request);
  }

  // Protect all other routes
  if (!token) {
    const loginUrl = new URL('/login', request.url);
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return nextWithCsp(request);
}

export const config = {
  matcher: [
    // Match API routes for proxying
    '/api/:path*',
    // Match OAuth endpoints for proxying. These have to be enumerated
    // explicitly because the catch-all matcher below excludes any path
    // containing a dot (intended for static files), which would otherwise
    // skip the well-known metadata routes.
    '/oauth/:path*',
    '/oauth-consent/:path*',
    '/.well-known/oauth-protected-resource',
    '/.well-known/oauth-authorization-server',
    '/.well-known/oauth-authorization-server/:path*',
    '/.well-known/openid-configuration',
    // Match all other paths except static files
    '/((?!_next/static|_next/image|favicon.ico|.*\\..*|public).*)',
  ],
};
