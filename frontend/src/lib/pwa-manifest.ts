import type { MetadataRoute } from 'next';
import type { ColorTheme } from './color-themes';
import { bootPageColor, type ResolvedTheme } from './pwa-theme';

// The OS builds the PWA splash screen from the manifest's background_color,
// icon and name, captured when the manifest was last fetched -- there is no
// media query in the manifest format. Serving the manifest dynamically from
// the resolved-theme and colour-palette cookies is the only lever: browsers
// re-check the manifest on launch, so the splash follows the user's theme
// from the next launch on. With no cookies (fresh browser, cookie expired)
// the default light palette is served, matching the pre-cookie behaviour.
export function buildManifest(
  theme: ResolvedTheme | null,
  colorTheme: ColorTheme | null = null,
): MetadataRoute.Manifest {
  const page = bootPageColor(colorTheme, theme);
  return {
    // The manifest URL varies with the theme query string, so the app's
    // identity is pinned explicitly -- every variant is the same app.
    id: '/',
    name: 'Monize - Personal Finance Manager',
    short_name: 'Monize',
    description: 'Track your finances, manage budgets, and monitor investments',
    start_url: '/',
    display: 'standalone',
    background_color: page,
    theme_color: page,
    orientation: 'portrait-primary',
    icons: [
      {
        src: '/icons/icon-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-maskable-192x192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'maskable',
      },
      {
        src: '/icons/icon-maskable-512x512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
