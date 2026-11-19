import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@/test/render";
import BankSyncSettingsPage from "./page";
import type { BankSyncConnection, BankSyncStatus } from "@/types/bank-sync";
import { nativeSelectOf, selectOptionLabels } from "@/test/icon-select";

vi.mock("@/components/auth/ProtectedRoute", () => ({
  ProtectedRoute: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

vi.mock("@/components/layout/PageLayout", () => ({
  PageLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="page-layout">{children}</div>
  ),
}));

const mockSimplefinStatus = vi.fn();
vi.mock("@/lib/simplefin", () => ({
  simplefinApi: {
    getStatus: (...args: unknown[]) => mockSimplefinStatus(...args),
  },
}));
const mockGetStatus = vi.fn();
const mockListConnections = vi.fn();
const mockGetAccounts = vi.fn();
const mockDeleteConnection = vi.fn();

vi.mock("@/lib/bank-sync", () => ({
  bankSyncApi: {
    getStatus: (...args: unknown[]) => mockGetStatus(...args),
    listConnections: (...args: unknown[]) => mockListConnections(...args),
    listInstitutions: vi.fn().mockResolvedValue([]),
    deleteConnection: (...args: unknown[]) => mockDeleteConnection(...args),
  },
}));

vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: unknown[]) => mockGetAccounts(...args) },
}));

const mockUseDemoMode = vi.fn(() => false);
vi.mock("@/hooks/useDemoMode", () => ({
  useDemoMode: () => mockUseDemoMode(),
}));

const status = (over: Partial<BankSyncStatus> = {}): BankSyncStatus => ({
  encryptionAvailable: true,
  providers: ["enable_banking"],
  credentials: {
    provider: "enable_banking",
    applicationId: "app-1",
    privateKeySet: true,
  },
  redirectUrl: "https://monize.example/settings/bank-sync/callback",
  ...over,
});

const connection = (
  over: Partial<BankSyncConnection> = {},
): BankSyncConnection => ({
  id: "c1",
  provider: "enable_banking",
  institutionName: "Alpha Bank",
  institutionCountry: "PL",
  status: "active",
  validUntil: "2099-01-01T00:00:00.000Z",
  autoSync: false,
  notifySuccess: "when_imported",
  tagOperationType: true,
  lastError: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  profile: { id: "default", version: 1, notes: [] },
  accounts: [],
  ...over,
});

async function renderPage() {
  await act(async () => {
    render(<BankSyncSettingsPage />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseDemoMode.mockReturnValue(false);
  mockGetStatus.mockResolvedValue(status());
  mockSimplefinStatus.mockResolvedValue({
    provider: "simplefin",
    credentialSet: false,
    encryptionAvailable: true,
    quota: null,
  });
  mockListConnections.mockResolvedValue([]);
  mockGetAccounts.mockResolvedValue([]);
});

describe("BankSyncSettingsPage", () => {
  it("shows the header, and no empty state, while it loads", () => {
    mockGetStatus.mockReturnValue(new Promise(() => {}));
    mockListConnections.mockReturnValue(new Promise(() => {}));
    render(<BankSyncSettingsPage />);

    expect(screen.getAllByText("Bank Sync").length).toBeGreaterThan(0);
    expect(screen.queryByText("No banks connected")).toBeNull();
  });

  it("links back to Settings", async () => {
    await renderPage();

    expect(
      screen.getByRole("link", { name: /Back to Settings/ }),
    ).toHaveAttribute("href", "/settings");
  });

  it("shows the credentials and, with no connections, the empty state", async () => {
    await renderPage();

    expect(screen.getByText("Enable Banking application")).toBeInTheDocument();
    expect(screen.getByText("app-1")).toBeInTheDocument();
    expect(screen.getByText("No banks connected")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Connect a bank" }),
    ).toBeEnabled();
  });

  it("lists each connection with its accounts", async () => {
    mockListConnections.mockResolvedValue([
      connection(),
      connection({ id: "c2", institutionName: "Beta Credit" }),
    ]);
    await renderPage();

    expect(
      screen.getByRole("heading", { name: "Alpha Bank" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Beta Credit" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("No banks connected")).toBeNull();
  });

  it("cannot connect a bank before credentials are stored, and says why", async () => {
    mockGetStatus.mockResolvedValue(status({ credentials: null }));
    await renderPage();

    expect(
      screen.getByRole("button", { name: "Connect a bank" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Set up your Enable Banking credentials above/),
    ).toBeInTheDocument();
  });

  it("cannot connect a bank when credentials have no key stored", async () => {
    mockGetStatus.mockResolvedValue(
      status({
        credentials: {
          provider: "enable_banking",
          applicationId: "app-1",
          privateKeySet: false,
        },
      }),
    );
    await renderPage();

    expect(
      screen.getByRole("button", { name: "Connect a bank" }),
    ).toBeDisabled();
  });

  it("opens the connect dialog", async () => {
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect a bank" }));
    });

    expect(screen.getByLabelText("Country")).toBeInTheDocument();
  });

  describe("a failed read is not an empty list", () => {
    it("shows an error with retry when the connections cannot be read", async () => {
      mockListConnections.mockRejectedValueOnce(new Error("down"));
      await renderPage();

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not load your bank connections.",
      );
      expect(screen.queryByText("No banks connected")).toBeNull();

      mockListConnections.mockResolvedValueOnce([connection()]);
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });

      expect(
        await screen.findByRole("heading", { name: "Alpha Bank" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Could not load your bank connections."),
      ).toBeNull();
    });

    it("treats a failed accounts read as a failed read of the connections", async () => {
      mockListConnections.mockResolvedValue([connection()]);
      mockGetAccounts.mockRejectedValueOnce(new Error("down"));
      await renderPage();

      expect(
        screen.getByText("Could not load your bank connections."),
      ).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Alpha Bank" })).toBeNull();
    });

    it("shows an error with retry when the status cannot be read, and keeps connections", async () => {
      mockGetStatus.mockRejectedValueOnce(new Error("down"));
      mockListConnections.mockResolvedValue([connection()]);
      await renderPage();

      expect(screen.getByText("Could not load bank sync")).toBeInTheDocument();
      expect(screen.queryByText("Enable Banking application")).toBeNull();
      expect(
        screen.getByRole("heading", { name: "Alpha Bank" }),
      ).toBeInTheDocument();
      // Not knowing whether credentials are stored is not "none stored".
      expect(screen.queryByText("No application is set up yet.")).toBeNull();

      mockGetStatus.mockResolvedValueOnce(status());
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      });
      expect(
        await screen.findByText("Enable Banking application"),
      ).toBeInTheDocument();
    });
  });

  it("never offers an account another bank account is linked to", async () => {
    mockListConnections.mockResolvedValue([
      connection({
        accounts: [
          {
            id: "ba-1",
            connectionId: "c1",
            displayName: "First",
            identifierMasked: null,
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: "EUR",
            accountId: "a1",
            syncFromDate: "2026-01-01",
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            lastImportedCount: null,
            lastSkippedCount: null,
            lastRefusedCount: null,
            bankBalance: null,
            bankBalanceCurrency: null,
            bankBalanceDate: null,
            needsPreview: false,
          },
          {
            id: "ba-2",
            connectionId: "c1",
            displayName: "Second",
            identifierMasked: null,
            accountIdentifier: null,
            cashAccountType: null,
            currencyCode: "EUR",
            accountId: null,
            syncFromDate: null,
            lastSyncedAt: null,
            lastSyncStatus: null,
            lastSyncError: null,
            lastImportedCount: null,
            lastSkippedCount: null,
            lastRefusedCount: null,
            bankBalance: null,
            bankBalanceCurrency: null,
            bankBalanceDate: null,
            needsPreview: false,
          },
        ],
      }),
    ]);
    mockGetAccounts.mockResolvedValue([
      {
        id: "a1",
        name: "Checking",
        currencyCode: "EUR",
        isClosed: false,
        accountSubType: null,
        currentBalance: 0,
        isFavourite: false,
        favouriteSortOrder: 0,
      },
      {
        id: "a2",
        name: "Savings",
        currencyCode: "EUR",
        isClosed: false,
        accountSubType: null,
        currentBalance: 0,
        isFavourite: false,
        favouriteSortOrder: 0,
      },
    ]);
    await renderPage();

    const [first, second] = screen
      .getAllByLabelText("Monize account")
      .map(nativeSelectOf);
    expect(selectOptionLabels(first)).toEqual([
      "Not linked",
      "Create a new account",
      "Checking (EUR)",
      "Savings (EUR)",
    ]);
    expect(first.value).toBe("a1");
    expect(selectOptionLabels(second)).toEqual([
      "Not linked",
      "Create a new account",
      "Savings (EUR)",
    ]);
  });

  describe("demo mode", () => {
    it("shows the restriction and disables the writes", async () => {
      mockUseDemoMode.mockReturnValue(true);
      mockListConnections.mockResolvedValue([connection()]);
      await renderPage();

      expect(screen.getByText("Restricted in Demo Mode")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Connect a bank" }),
      ).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Edit credentials" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: "Disconnect" })).toBeDisabled();
    });
  });

  it("reloads the connections after a change made on a card", async () => {
    mockListConnections.mockResolvedValue([connection()]);
    await renderPage();
    expect(mockListConnections).toHaveBeenCalledTimes(1);

    // Disconnect is a write that reloads the list.
    mockDeleteConnection.mockResolvedValue(undefined);
    mockListConnections.mockResolvedValue([]);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getAllByRole("button", { name: "Disconnect" }).at(-1)!,
      );
    });

    await waitFor(() => expect(mockListConnections).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No banks connected")).toBeInTheDocument();
  });
});

it("selects SimpleFIN without RSA or OAuth controls and filters institutions by provider", async () => {
  mockListConnections.mockResolvedValue([
    connection(),
    connection({
      id: "sf",
      provider: "simplefin",
      institutionName: "US Demo Bank",
      institutionCountry: "",
      validUntil: null,
    }),
  ]);
  await renderPage();
  fireEvent.change(screen.getByRole("combobox", { name: "Data provider" }), {
    target: { value: "simplefin" },
  });
  await waitFor(() =>
    expect(screen.getByLabelText("Setup token")).toBeEnabled(),
  );
  expect(screen.queryByText("Enable Banking application")).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect a bank" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "Alpha Bank" })).toBeNull();
  expect(
    screen.getByRole("heading", { name: "US Demo Bank" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Renew consent/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Stop syncing" })).toBeEnabled();
  fireEvent.change(screen.getByRole("combobox", { name: "Data provider" }), {
    target: { value: "enable_banking" },
  });
  expect(screen.getByText("Enable Banking application")).toBeInTheDocument();
  expect(
    screen.getByRole("heading", { name: "Alpha Bank" }),
  ).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "US Demo Bank" })).toBeNull();
});

describe("provider default from active linked accounts", () => {
  const linkedAccount = {
    id: "ba-default",
    connectionId: "sf-default",
    displayName: "Linked",
    identifierMasked: null,
    accountIdentifier: null,
    cashAccountType: null,
    currencyCode: "USD",
    accountId: "a-default",
    syncFromDate: null,
    lastSyncedAt: null,
    lastSyncStatus: null,
    lastSyncError: null,
    lastImportedCount: null,
    lastSkippedCount: null,
    lastRefusedCount: null,
    bankBalance: null,
    bankBalanceCurrency: null,
    bankBalanceDate: null,
    needsPreview: false,
  } satisfies BankSyncConnection["accounts"][number];
  const liveSimplefin = (over: Partial<BankSyncConnection> = {}) =>
    connection({
      id: "sf-default",
      provider: "simplefin",
      institutionName: "Example Bank",
      institutionCountry: "",
      validUntil: null,
      accounts: [linkedAccount],
      ...over,
    });
  const selector = () =>
    screen.getByRole("combobox", { name: "Data provider" });
  beforeEach(() => {
    mockGetAccounts.mockResolvedValue([{ id: "a-default", isClosed: false }]);
  });

  it("defaults to SimpleFIN with active linked accounts even with manual sync", async () => {
    mockListConnections.mockResolvedValue([liveSimplefin({ autoSync: false })]);
    await renderPage();
    expect(selector()).toHaveValue("simplefin");
    expect(
      screen.getByRole("heading", { name: "Example Bank" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Enable Banking application")).toBeNull();
  });

  it("keeps Enable Banking when both providers have active linked accounts", async () => {
    mockListConnections.mockResolvedValue([
      liveSimplefin(),
      connection({ accounts: [linkedAccount] }),
    ]);
    await renderPage();
    expect(selector()).toHaveValue("enable_banking");
  });

  it.each(["pending", "expired", "revoked", "failed"] as const)(
    "ignores a %s Enable Banking connection",
    async (status) => {
      mockListConnections.mockResolvedValue([
        liveSimplefin(),
        connection({ status, accounts: [linkedAccount] }),
      ]);
      await renderPage();
      expect(selector()).toHaveValue("simplefin");
    },
  );

  it("ignores unlinked Enable Banking connections", async () => {
    mockListConnections.mockResolvedValue([liveSimplefin(), connection()]);
    await renderPage();
    expect(selector()).toHaveValue("simplefin");
  });

  it.each(["pending", "expired", "revoked", "failed"] as const)(
    "keeps Enable Banking for a %s SimpleFIN connection",
    async (status) => {
      mockListConnections.mockResolvedValue([liveSimplefin({ status })]);
      await renderPage();
      expect(selector()).toHaveValue("enable_banking");
    },
  );

  it("keeps Enable Banking when SimpleFIN accounts are unlinked", async () => {
    mockListConnections.mockResolvedValue([
      liveSimplefin({ accounts: [{ ...linkedAccount, accountId: null }] }),
    ]);
    await renderPage();
    expect(selector()).toHaveValue("enable_banking");
  });

  it("keeps Enable Banking when the linked Monize account is closed", async () => {
    mockGetAccounts.mockResolvedValue([{ id: "a-default", isClosed: true }]);
    mockListConnections.mockResolvedValue([liveSimplefin()]);
    await renderPage();
    expect(selector()).toHaveValue("enable_banking");
  });

  it("ignores Enable Banking accounts linked only to a closed Monize account", async () => {
    mockGetAccounts.mockResolvedValue([
      { id: "a-default", isClosed: false },
      { id: "closed", isClosed: true },
    ]);
    mockListConnections.mockResolvedValue([
      liveSimplefin(),
      connection({ accounts: [{ ...linkedAccount, accountId: "closed" }] }),
    ]);
    await renderPage();
    expect(selector()).toHaveValue("simplefin");
  });

  it("preserves a manual choice made before the connections finish loading", async () => {
    let resolve!: (rows: BankSyncConnection[]) => void;
    mockListConnections.mockReturnValue(
      new Promise<BankSyncConnection[]>((done) => {
        resolve = done;
      }),
    );
    await renderPage();
    await act(async () => {
      fireEvent.change(selector(), { target: { value: "enable_banking" } });
    });
    await act(async () => {
      resolve([liveSimplefin()]);
    });
    expect(selector()).toHaveValue("enable_banking");
  });

  it("lets the user switch back to Enable Banking after the SimpleFIN default", async () => {
    mockListConnections.mockResolvedValue([liveSimplefin()]);
    await renderPage();
    expect(selector()).toHaveValue("simplefin");
    await act(async () => {
      fireEvent.change(selector(), { target: { value: "enable_banking" } });
    });
    expect(selector()).toHaveValue("enable_banking");
    expect(screen.getByText("Enable Banking application")).toBeInTheDocument();
  });

  it("keeps the fallback and error when loading connections fails", async () => {
    mockListConnections.mockRejectedValue(new Error("down"));
    await renderPage();
    expect(selector()).toHaveValue("enable_banking");
    expect(
      screen.getByText("Could not load your bank connections."),
    ).toBeInTheDocument();
  });
});
