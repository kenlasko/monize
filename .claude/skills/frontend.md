# Frontend Architecture

## Tech Stack
- **Framework:** Next.js 16 (App Router) with React 19, TypeScript 5.9
- **State:** Zustand 5 (authStore, preferencesStore) with localStorage persistence
- **Forms:** React Hook Form 7 + Zod 4 (custom zodResolver at `lib/zodResolver.ts`)
- **HTTP:** Axios with CSRF/token-refresh interceptors (`lib/api.ts`)
- **Charts:** Recharts 3 (PieChart, BarChart, AreaChart, ReferenceDot)
- **Styling:** Tailwind CSS 4 (utility-first, `dark:` prefix, mobile-first responsive `sm:`/`md:`)
- **Icons:** Heroicons React 2
- **Dates:** date-fns 4
- **Toasts:** React Hot Toast 2
- **Testing:** Vitest 4 + Testing Library + MSW 2

## Directory Structure
```
src/
  app/              # Next.js App Router pages (file-based routing)
  components/       # React components organized by feature domain
    accounts/       # AccountForm, AccountList
    admin/          # Admin panel components
    auth/           # Login, Register, 2FA components
    bills/          # Bill management
    categories/     # CategoryForm, CategoryTree (hierarchical)
    dashboard/      # NetWorthChart, IncomeExpensesBarChart, UpcomingBills,
                    #   FavouriteAccounts, TopMovers, GettingStartedPanel
    import/         # QIF/OFX import
    investments/    # PortfolioSummaryCard, AssetAllocationChart,
                    #   GroupedHoldingsList, InvestmentTransactionList,
                    #   InvestmentValueChart
    layout/         # PageLayout, AppHeader, PageHeader
    payees/         # PayeeForm, PayeeList
    providers/      # PreferencesLoader, StoreProvider, ServiceWorkerRegistrar
    reports/        # NetWorthReport, built-in + custom report renderers
    scheduled-transactions/
    securities/     # Security management
    transactions/   # TransactionForm, TransactionList, SplitEditor
    ui/             # Generic reusable: Button, Modal, Select, Combobox,
                    #   MultiSelect, Pagination, CurrencyInput, NumericInput,
                    #   ConfirmDialog, ColorPicker, IconPicker, ThemeToggle,
                    #   DateRangeSelector, LoadingSpinner, ErrorBoundary
  contexts/         # ThemeContext (light/dark/system)
  hooks/            # Custom hooks (see below)
  lib/              # API service files + utilities (see below)
  store/            # Zustand stores (authStore, preferencesStore)
  types/            # TypeScript interfaces/enums per domain
```

## Key Routes
| Route | Purpose |
|---|---|
| `/login`, `/register` | Auth |
| `/auth/callback` | OIDC callback |
| `/dashboard` | Main dashboard with charts |
| `/transactions` | Transaction list with filters |
| `/accounts` | Account management |
| `/investments` | Portfolio, holdings, transactions |
| `/bills` | Bills and deposits |
| `/reports` | Built-in reports |
| `/reports/custom/[id]` | Custom report view |
| `/categories`, `/payees`, `/securities` | Master data |
| `/settings` | User preferences |
| `/admin/users` | Admin panel |
| `/setup-2fa`, `/change-password` | Auth flows |

## API Service Layer (`src/lib/`)
Each file exports an object with async methods that call `apiClient` (Axios at `/api/v1`):

| File | Endpoints |
|---|---|
| `api.ts` | Axios instance + CSRF/401 interceptors |
| `auth.ts` | Login, register, 2FA, OIDC, password reset |
| `accounts.ts` | CRUD, balance, summary, investment pairs, loan/mortgage preview |
| `transactions.ts` | CRUD with pagination, transfers, splits, reconciliation |
| `categories.ts` | CRUD, tree, import defaults, transaction counts |
| `payees.ts` | CRUD, search, autocomplete, category suggestions |
| `investments.ts` | Portfolio summary, holdings, investment transactions |
| `exchange-rates.ts` | Rates, currencies |
| `scheduled-transactions.ts` | Recurring transactions |
| `custom-reports.ts` | Custom report CRUD + execution |
| `built-in-reports.ts` | Pre-defined report execution |
| `net-worth.ts` | Net worth summary data |
| `user-settings.ts` | Profile, preferences, password |
| `admin.ts` | Admin user management |
| `import.ts` | QIF/OFX file import |

**Service pattern:**
```typescript
export const resourceApi = {
  getAll: async (params?) => (await apiClient.get('/resource', { params })).data,
  getById: async (id) => (await apiClient.get(`/resource/${id}`)).data,
  create: async (data) => (await apiClient.post('/resource', data)).data,
  update: async (id, data) => (await apiClient.patch(`/resource/${id}`, data)).data,
  delete: async (id) => apiClient.delete(`/resource/${id}`),
};
```

## Custom Hooks (`src/hooks/`)
| Hook | Purpose |
|---|---|
| `useNumberFormat` | Currency formatting: `formatCurrency`, `formatCurrencyCompact`, `formatCurrencyAxis`, `formatCurrencyLabel` (compact K/M/B/T) |
| `useDateFormat` | Date formatting per user preferences |
| `useDateRange` | Date range presets (1m, 3m, 6m, 1y, custom) |
| `useExchangeRates` | `convertToDefault(amount, currencyCode)`, `defaultCurrency` |
| `useFormModal` | Generic create/edit modal state (`showForm`, `editingItem`, `openCreate`, `openEdit`, `close`) |
| `useLocalStorage` | Syncs React state to localStorage |
| `usePriceRefresh` | Investment price refresh polling |

## Type Definitions (`src/types/`)
One file per domain: `account.ts`, `transaction.ts`, `category.ts`, `payee.ts`, `investment.ts`, `custom-report.ts`, `scheduled-transaction.ts`, `built-in-reports.ts`, `net-worth.ts`, `auth.ts`

Key patterns:
- Interfaces for API responses (e.g., `Account`, `Transaction`, `PortfolioSummary`)
- Enums for constants (e.g., `AccountType`, `TransactionStatus`, `ReportViewType`)
- Separate `Create*Data` / `Update*Data` types for mutations
- Nested types with relations (Category has `children: Category[]`, Transaction has splits)

## State Management (Zustand)
**authStore:** `user`, `isAuthenticated`, `isLoading` + `login()`, `logout()`, `setUser()`
- Persists `user` + `isAuthenticated` to localStorage (NOT token - uses httpOnly cookies)
- `_hasHydrated` flag prevents SSR mismatch

**preferencesStore:** `preferences` (UserPreferences) + `loadPreferences()`, `updatePreferences()`
- Includes: `defaultCurrency`, `dateFormat`, `numberFormat`, `theme`, `timezone`
- Loaded by `PreferencesLoader` component on auth

## Styling Conventions
- **Card containers:** `bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6`
- **Section headers:** `text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4`
- **Labels:** `text-sm text-gray-500 dark:text-gray-400`
- **Values:** `text-lg font-semibold text-gray-900 dark:text-gray-100`
- **Positive values:** `text-green-600 dark:text-green-400`
- **Negative values:** `text-red-600 dark:text-red-400`
- **Dividers:** `border-t border-gray-200 dark:border-gray-700`
- **Mobile padding:** Use `p-3 sm:p-6` pattern (tight on mobile, normal on desktop)
- **Table cell padding:** `px-2 sm:px-6` or `px-1.5 sm:px-4`
- **Utility function:** `cn()` from `lib/utils.ts` (clsx + twMerge)

## Common Patterns

### Form handling
```typescript
const schema = z.object({ name: z.string().min(1), amount: z.number() });
const { register, handleSubmit, formState } = useForm({
  resolver: zodResolver(schema),
  defaultValues: existingItem,
});
```

### Data fetching
```typescript
useEffect(() => {
  const load = async () => {
    try { setData(await api.getAll()); }
    catch { toast.error('Failed to load'); }
    finally { setIsLoading(false); }
  };
  load();
}, []);
```

### API client (`lib/api.ts`) interceptors
- **Request:** Adds `X-CSRF-Token` header from cookie
- **403 response:** Refreshes CSRF token transparently, retries request
- **401 response:** Queues requests, refreshes auth token via `/auth/refresh`, retries all queued

### Proxy setup
- Frontend proxies `/api/v1/*` to backend via `src/proxy.ts` (NOT middleware - middleware is deprecated)
- `INTERNAL_API_URL` set at container start time (default `http://localhost:3001`)

### Logging
```typescript
const logger = createLogger('ComponentName');
logger.debug('Message'); // Controlled by NEXT_PUBLIC_LOG_LEVEL
```
