import { BOOT_BACKGROUND, BOOT_FOREGROUND, type ResolvedTheme } from '@/lib/pwa-theme';

export const BOOT_SPLASH_ID = 'monize-boot-splash';

// How long the boot screen waits before admitting something is wrong. Long
// enough that a slow-but-working boot never shows it, short enough that a
// user staring at a hung PWA gets a way out without force-closing the app.
const SLOW_REVEAL_SECONDS = 12;
// The logo springs in, then breathes with a halo in the palette's accent.
const LOGO_IN_SECONDS = 0.7;
const BOOT_GLOW_FALLBACK = '#3b82f6';
// The path of public/icons/monize-logo-transparent.svg; BootSplash.test.tsx holds them equal.
const BOOT_LOGO_PATH =
  'M180,746.03C180,745.5,241.08,587.75,240.54,587.21C239.76,586.42,160.35,605,156.97,605C154.45,605,250.9108,306.5358,251.3208,308.1458C257.7723,308.0924,329.0739,495.3686,330.7139,498.1686C331.3839,499.3086,291.0173,536.7598,291.0173,537.5398C291.0173,539.1498,378.91,633,380.5,633C382.09,633,470.9533,539.4752,470.9533,537.8652C470.9533,537.0852,430.6059,498.0059,430.6059,498.0059L510.6498,307.8204C510.6498,307.8204,604.8835,600.3288,605.9135,604.8788C606.5535,607.7288,520.13,586.54,519.42,587.24C519.18,587.49,579.95,747,579.95,747L751.16,747C751.16,747,521.39,11,520.97,11C520.6086,11,381.9709,379.8984,381.8161,380.3213C379.7961,385.8813,239.62,9.64,239.62,9.64L9.79,747C9.79,747,180,746.65,180,746.03z';

export interface BootSplashStrings {
  loading: string;
  slowMessage: string;
  reload: string;
}

interface BootSplashProps {
  // The resolved theme from the monize-resolved-theme cookie, or null when
  // the cookie is absent -- in which case the palette follows the system
  // preference via prefers-color-scheme.
  bootTheme: ResolvedTheme | null;
  strings: BootSplashStrings;
}

// The first thing the server paints, rendered in the root layout *outside*
// ThemeProvider. ThemeProvider returns null until it has read localStorage,
// so everything inside it ships as an empty body and nothing paints until
// the full JS bundle has loaded, hydrated and mounted -- on a flaky network
// that is an indefinite blank screen, which in the installed PWA is
// indistinguishable from being stuck on the OS splash. This overlay paints
// immediately with zero JS, and after SLOW_REVEAL_SECONDS a pure-CSS delayed
// animation reveals a reload link so a hung boot always leaves the user an
// exit that is not force-closing the app. BootSplashHider hides it (never
// detaches it -- this node is React-owned) once the app tree has actually
// mounted.
//
// Everything here is self-contained (inline styles, no app CSS, no JS) so it
// still works when static assets are unreachable. The colours read the
// palette tokens (layout.tsx stamps data-theme from the cookie, so the
// active colour theme's ramp is live before hydration) and fall back to the
// stock palette when the app stylesheet never arrived.
export function BootSplash({ bootTheme, strings }: BootSplashProps) {
  const darkRules =
    `background: var(--color-gray-900, ${BOOT_BACKGROUND.dark}); ` +
    `color: var(--color-gray-100, ${BOOT_FOREGROUND.dark});`;
  const css = `
#${BOOT_SPLASH_ID} {
  position: fixed;
  inset: 0;
  z-index: 2147483000;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: calc(env(safe-area-inset-top) + 16px) 24px calc(env(safe-area-inset-bottom) + 16px);
  text-align: center;
  font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
  background: var(--color-gray-50, ${BOOT_BACKGROUND.light});
  color: var(--color-gray-900, ${BOOT_FOREGROUND.light});
}
html.dark #${BOOT_SPLASH_ID} { ${darkRules} }
@media (prefers-color-scheme: dark) {
  #${BOOT_SPLASH_ID}[data-boot-theme='system'] { ${darkRules} }
}
#${BOOT_SPLASH_ID} .boot-splash-mark { position: relative; display: flex; width: 72px; height: 72px; }
#${BOOT_SPLASH_ID} .boot-splash-logo { position: relative; width: 72px; height: 72px; }
#${BOOT_SPLASH_ID} .boot-splash-mark::before {
  content: '';
  position: absolute;
  inset: -36px;
  border-radius: 9999px;
  background: radial-gradient(circle, color-mix(in srgb, var(--color-blue-500, ${BOOT_GLOW_FALLBACK}) 30%, transparent), transparent 68%);
  opacity: 0;
}
#${BOOT_SPLASH_ID} .boot-splash-spinner {
  width: 28px;
  height: 28px;
  border-radius: 9999px;
  border: 3px solid currentColor;
  border-top-color: transparent;
  opacity: 0.4;
  animation: monize-boot-spin 0.9s linear infinite;
}
#${BOOT_SPLASH_ID} .boot-splash-slow {
  position: absolute;
  left: 24px;
  right: 24px;
  bottom: calc(env(safe-area-inset-bottom) + 48px);
  font-size: 14px;
  line-height: 1.5;
  opacity: 0;
  visibility: hidden;
  animation: monize-boot-reveal 0.4s ease-out ${SLOW_REVEAL_SECONDS}s forwards;
}
#${BOOT_SPLASH_ID} .boot-splash-slow a {
  color: inherit;
  font-weight: 600;
  text-decoration: underline;
}
@keyframes monize-boot-spin { to { transform: rotate(360deg); } }
@keyframes monize-boot-reveal { to { opacity: 1; visibility: visible; } }
@keyframes monize-boot-logo-in { from { opacity: 0; transform: scale(0.72); } }
@keyframes monize-boot-logo-breathe { 50% { transform: scale(1.06); } }
@keyframes monize-boot-halo { 50% { opacity: 1; } }
@media (prefers-reduced-motion: no-preference) {
  #${BOOT_SPLASH_ID} .boot-splash-logo {
    animation:
      monize-boot-logo-in ${LOGO_IN_SECONDS}s cubic-bezier(0.34, 1.56, 0.64, 1) both,
      monize-boot-logo-breathe 2.4s ease-in-out ${LOGO_IN_SECONDS}s infinite;
  }
  #${BOOT_SPLASH_ID} .boot-splash-mark::before {
    animation: monize-boot-halo 2.4s ease-in-out ${LOGO_IN_SECONDS}s infinite;
  }
}
@media (prefers-reduced-motion: reduce) {
  #${BOOT_SPLASH_ID} .boot-splash-spinner { display: none; }
}
`;

  return (
    <div
      id={BOOT_SPLASH_ID}
      data-boot-theme={bootTheme ?? 'system'}
      role="status"
      aria-label={strings.loading}
    >
      <style>{css}</style>
      <div className="boot-splash-mark">
        {/* Inline, not an <img>: a file would still be downloading on a slow
            connection while the halo and spinner, which arrive with the HTML,
            are already on screen. */}
        <svg
          className="boot-splash-logo"
          viewBox="-600 -600 1000 1000"
          aria-hidden="true"
        >
          <g transform="translate(-481.057, -489.3737)">
            <path fill="#4fa091" d={BOOT_LOGO_PATH} />
          </g>
        </svg>
      </div>
      <div className="boot-splash-spinner" aria-hidden="true" />
      <p className="boot-splash-slow">
        {strings.slowMessage}{' '}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- a
            plain anchor is the point: this link exists for when the JS
            runtime never arrived, so it cannot depend on next/link */}
        <a href="/">{strings.reload}</a>
      </p>
    </div>
  );
}
