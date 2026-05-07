# Frontend Directory

Next.js App Router application. All commands run from this directory.

## Commands

```bash
npm run dev                # Dev server (port 3000)
npm run build              # Production build (standalone output for Docker)
npm run lint               # ESLint
npm run type-check         # tsc --noEmit
npm run test               # Vitest (single run)
npm run test:watch         # Vitest (watch mode)
npm run test:cov           # Coverage report (91% lines, 90% stmts, 87% funcs, 85% branches)
```

## Layout

`src/` contains `app/` (App Router routes), `components/` (feature-organized React components plus shared `ui/`), `contexts/`, `hooks/`, `lib/` (axios API clients and utilities), `store/` (Zustand: `authStore`, `preferencesStore`, `demoStore`), `types/`, `test/`, and `proxy.ts`. Use the filesystem or LSP `workspaceSymbol` to discover specific files -- they're self-describing.

## Configuration

- **Path alias:** `@/*` maps to `src/*` (tsconfig + Vitest resolve alias)
- **TypeScript:** ES2017 target, strict mode, bundler module resolution, React JSX
- **Vitest:** jsdom environment, 30s timeout, V8 coverage provider; thresholds 91% lines, 90% statements, 87% functions, 85% branches
- **Tailwind CSS v4:** Via `@tailwindcss/postcss` in `postcss.config.js`, `@import "tailwindcss"` in `globals.css`
- **Next.js:** Standalone output (Docker), strict mode, security headers in `next.config.js`

## API Layer (`src/lib/`)

**Central client** (`api.ts`): Axios instance with `baseURL: /api/v1`, `withCredentials: true`, 10s timeout.

**Interceptors (non-obvious behavior):**
- **Request:** Reads `csrf_token` cookie, injects `X-CSRF-Token` header
- **Response (403 CSRF):** Transparent refresh via `/auth/csrf-refresh`, retries request
- **Response (401):** Token refresh via `/auth/refresh`, queues concurrent requests during refresh
- **Fallback:** On refresh failure, logs out and redirects to `/login`

Feature API modules (one per feature, typed axios wrappers) live alongside `api.ts`. Use the filesystem to discover them.

## Proxy (`src/proxy.ts`)

This is Next.js middleware (NOT the deprecated middleware pattern from this project's conventions). It handles:

- **API routing:** `/api/*` proxied to `INTERNAL_API_URL` (default `http://localhost:3001`)
- **CSP nonce:** Per-request nonce generated in `x-nonce` header, used by Next.js for inline scripts
- **Auth redirects:** Unauthenticated requests to protected routes redirect to `/login`
- **Security headers:** CSP with `strict-dynamic`, nonce-based script-src
- **Public paths:** `/login`, `/register`, `/auth/callback`, `/forgot-password`, `/reset-password` (no auth required)

## Component Patterns

- All interactive components use `'use client'`. Server components are the default for pages/layouts.
- Use dynamic imports for heavy components: `dynamic(() => import('./Chart'), { ssr: false })`.
- `ProtectedRoute` (`components/auth/ProtectedRoute.tsx`) wraps authenticated pages.
- **No `setState` in `useEffect`** — ESLint rule `react-hooks/set-state-in-effect` is enforced. To reset child state when a prop changes (e.g. on a dialog open transition), use the "info from previous render" pattern (track the prop in `useState` and update during render).
- **Dialogs use `Modal`** (`components/ui/Modal.tsx`) — handles Escape, focus trap, body scroll lock, focus restore, and stacked-modal popstate. Opt into `pushHistory` so the browser back button also closes. `ConfirmDialog` forwards `pushHistory` for stacked confirm flows.

## Form Patterns

`useFormModal<T>` (`hooks/useFormModal.ts`) manages create/edit modal state with browser-history integration (back button closes), unsaved-changes detection via `UnsavedChangesDialog`, and form submit exposed via ref. Returns `showForm`, `editingItem`, `openCreate()`, `openEdit(item)`, `close()`, `modalProps`, `unsavedChangesDialog`.

Supporting hooks: `useFormSubmitRef` (expose submit via ref), `useFormDirtyNotify` (track dirty state). Forms use react-hook-form + Zod.

## React Testing (act() Pattern)

Components with async `useEffect` (API calls on mount) MUST use this pattern to avoid act() warnings:

```typescript
async function renderMyComponent() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(<MyComponent />);
  });
  return result!;
}

it('renders data', async () => {
  const { getByText } = await renderMyComponent();
  expect(getByText('Expected')).toBeInTheDocument();
});
```

Wrap user interactions that trigger async state updates: `await act(async () => { fireEvent.click(button); });`

When a mock rejects a Promise, the component's error handler runs in a subsequent microtask after `act()` resolves. Add a flush after the interaction to drain it:

```typescript
await act(async () => { fireEvent.click(runBtn); });
await act(async () => {}); // flush pending rejection handlers
await waitFor(() => expect(screen.getByText('Error message')).toBeInTheDocument());
```

Never use synchronous `act(() => {...})` for calls that trigger async side-effects — always `await act(async () => {...})`.

## Testing Conventions

**Custom render** (`test/render.tsx`): Wraps components with `ThemeProvider`. Import `render` from `@/test/render` instead of `@testing-library/react`.

**Global mocks** (`test/setup.ts`): `next/navigation` (useRouter, usePathname, useSearchParams), `react-hot-toast`, `localStorage`, `window.scrollTo`, `window.matchMedia`.

**Test file naming:** `Component.test.tsx` (co-located with component).

## Theme

`ThemeContext` provides `theme` (light/dark/system), `resolvedTheme`, and `setTheme()`. Persisted to localStorage; applies `dark` class to `<html>` (Tailwind dark mode strategy); listens for system preference changes via `matchMedia`. Custom theme variables in `globals.css` `@theme` block; dark variant `@variant dark (&:where(.dark, .dark *))`.

## Security Notes

- **Zod:** Configured with `jitless: true` (`zodConfig.ts`) for CSP compliance -- no `new Function()`
- **Auth tokens:** Stored in httpOnly cookies (backend-managed), never in JS-accessible storage
- **CSP:** Per-request nonce generated in proxy, `strict-dynamic` for script-src
- **ESLint:** `no-new-func: error` enforced to prevent CSP violations
