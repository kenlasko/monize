const createNextIntlPlugin = require('next-intl/plugin');
const packageJson = require('./package.json');

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Next copies the body of EVERY request proxy.ts matches into memory before the
// proxy runs, up to this size, whatever the path and before any authentication
// -- so this is the most one unauthenticated request can make the frontend
// hold (twice: one copy for the proxy, one kept to replace the request body).
// It used to be the .mny import ceiling (308MB) for every path. It is now one
// MB above the backend's own 10MB default body limit, and the uploads that
// genuinely need more (the .mny import, the backup restore, the assistant's
// attachments, transaction attachments) are excluded from the proxy's matcher
// and streamed to the backend by route handlers instead, with their own
// per-route ceilings. Past this size Next truncates silently; the proxy refuses
// anything over 10MB with 413, so a truncated body is never forwarded.
// `NEXT_PROXY_CLIENT_MAX_BODY_MB` in src/lib/proxy-body-limit.ts names this
// value and `src/test/proxy-body-limit.test.ts` holds the two together.
const PROXY_BODY_LIMIT_MB = 11;

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    proxyClientMaxBodySize: `${PROXY_BODY_LIMIT_MB}mb`,
    // Turbopack's on-disk dev cache makes a restarted dev server fast, but it
    // writes and compacts in the background, and while it does a request for
    // an already-compiled page can stall for tens of seconds. A throwaway
    // container (the e2e stack) never restarts into that cache, so it sets
    // NEXT_DEV_FILESYSTEM_CACHE=false and pays none of the cost.
    turbopackFileSystemCacheForDev:
      process.env.NEXT_DEV_FILESYSTEM_CACHE !== 'false',
  },
  // Pin the dev (Turbopack) workspace root to this app so it doesn't scan the
  // whole monorepo (the backend tree) on every compile. The repo has multiple
  // lockfiles, which otherwise makes Next infer the monorepo root and slows
  // on-demand route compilation in dev.
  turbopack: { root: __dirname },
  output: 'standalone', // Optimized for Docker deployment
  serverExternalPackages: ['jspdf', 'jspdf-autotable', 'fflate'],
  poweredByHeader: false, // Remove X-Powered-By: Next.js header
  serverExternalPackages: ['jspdf'],
  env: {
    PUBLIC_APP_URL: process.env.PUBLIC_APP_URL || 'http://localhost:3000',
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
  },
  // API proxying and CSP are handled by proxy.ts at runtime
  // This allows INTERNAL_API_URL to be set at container start, not build time
  async headers() {
    const disableHttpsHeaders = process.env.DISABLE_HTTPS_HEADERS === 'true';
    const securityHeaders = [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      // CSP is set dynamically in proxy.ts with per-request nonces
      { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
    ];
    if (!disableHttpsHeaders) {
      securityHeaders.push(
        { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        // COOP + COEP enable cross-origin isolation. Every subresource is
        // same-origin (CSP is default-src 'self'; img/font allow only self,
        // data:, blob:) and already carries Cross-Origin-Resource-Policy:
        // same-origin, so require-corp loads cleanly without external opt-ins.
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
        { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
      );
    }
    // robots.txt and sitemap.xml contain a dot, so the proxy matcher skips them
    // and they never receive its nonce CSP. Neither is a document that loads
    // anything, so they get a policy that allows nothing. Not widened to every
    // dotted path: a CSP on sw.js would govern the service worker's own fetches.
    const lockedDownCsp = {
      key: 'Content-Security-Policy',
      value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    };
    return [
      { source: '/(.*)', headers: securityHeaders },
      { source: '/robots.txt', headers: [lockedDownCsp] },
      { source: '/sitemap.xml', headers: [lockedDownCsp] },
    ];
  },
};

module.exports = withNextIntl(nextConfig);
