import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, waitFor, within } from "@/test/render";
import { GemSettingsForm } from "./GemSettingsForm";
import { gemAssets, gemReport } from "@/test/gem-fixtures";

const mockGetAccounts = vi.fn();
vi.mock("@/lib/accounts", () => ({
  accountsApi: { getAll: (...args: unknown[]) => mockGetAccounts(...args) },
}));

const mockGetSecurities = vi.fn();
const mockCreateSecurity = vi.fn();
vi.mock("@/lib/investments", () => ({
  investmentsApi: {
    getSecurities: (...args: unknown[]) => mockGetSecurities(...args),
    createSecurity: (...args: unknown[]) => mockCreateSecurity(...args),
  },
}));

// The real security form is exercised by its own tests; here it only needs to
// hand a payload back so the assignment wiring can be asserted.
vi.mock("@/components/securities/SecurityForm", () => ({
  SecurityForm: ({
    onSubmit,
    onCancel,
  }: {
    onSubmit: (data: unknown) => Promise<void>;
    onCancel: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() =>
          onSubmit({
            symbol: "CSPX",
            name: "iShares Core S&P 500 UCITS ETF",
          }).catch(() => undefined)
        }
      >
        stub-create-security
      </button>
      <button type="button" onClick={onCancel}>
        stub-cancel-security
      </button>
    </div>
  ),
}));

const mockUpdateConfig = vi.fn();
vi.mock("@/lib/gem-strategy", () => ({
  gemStrategyApi: {
    updateConfig: (...args: unknown[]) => mockUpdateConfig(...args),
  },
}));

const mockToastSuccess = vi.fn();
const mockToastError = vi.fn();
vi.mock("react-hot-toast", () => ({
  default: {
    success: (message: string) => mockToastSuccess(message),
    error: (message: string) => mockToastError(message),
  },
}));

vi.mock("@/lib/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

const accounts = [
  {
    id: "acct-1",
    name: "Broker IRA",
    accountType: "INVESTMENT",
    accountSubType: "INVESTMENT_BROKERAGE",
    currencyCode: "USD",
  },
  {
    id: "acct-2",
    name: "Broker Taxable",
    accountType: "INVESTMENT",
    accountSubType: "INVESTMENT_BROKERAGE",
    currencyCode: "USD",
  },
  {
    id: "acct-cash",
    name: "Broker IRA Cash",
    accountType: "INVESTMENT",
    accountSubType: "INVESTMENT_CASH",
    currencyCode: "USD",
  },
  {
    id: "acct-chequing",
    name: "Chequing",
    accountType: "BANKING",
    accountSubType: null,
    currencyCode: "CAD",
  },
];

const securities = [
  // Exchange and currency are part of the fixtures because they are part of
  // an instrument's identity: the suggestions name a listing, and a bare
  // ticker is not one.
  {
    id: "sec-spy",
    symbol: "SPY",
    name: "SPDR S&P 500 ETF",
    exchange: "NYSEARCA",
    currencyCode: "USD",
    isActive: true,
  },
  {
    id: "sec-emim",
    symbol: "EMIM",
    name: "iShares MSCI EM IMI ETF",
    exchange: "LSE",
    currencyCode: "USD",
    isActive: true,
  },
  { id: "sec-old", symbol: "OLD", name: "Delisted ETF", isActive: false },
];

async function renderForm(
  props: Partial<Parameters<typeof GemSettingsForm>[0]> = {},
) {
  const onSaved = vi.fn();
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <GemSettingsForm
        strategy={gemReport().strategy}
        assets={gemAssets}
        range="1Y"
        onSaved={onSaved}
        {...props}
      />,
    );
  });
  return { ...result!, onSaved };
}

describe("GemSettingsForm", () => {
  /**
   * The role's dropdown trigger. Queried by role rather than by label: the
   * popup listbox is labelled by the same element, as the ARIA combobox
   * pattern prescribes, so the label alone matches two nodes.
   */
  const roleTrigger = (role: string) =>
    screen.getByRole("button", { name: role });

  /** Open a role's instrument dropdown and click one of its entries. */
  const pickInstrument = async (role: string, option: string | RegExp) => {
    await act(async () => {
      fireEvent.click(roleTrigger(role));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: option }));
    });
  };

  /** Every entry the role's dropdown offers, suggestions included. */
  const instrumentOptions = async (role: string) => {
    await act(async () => {
      fireEvent.click(roleTrigger(role));
    });
    // Scoped to the dropdown: a native <select> elsewhere on the form also
    // publishes its <option> children under the same role.
    const labels = within(screen.getByRole("listbox"))
      .getAllByRole("option")
      .map((option) => option.textContent?.trim() ?? "");
    await act(async () => {
      fireEvent.click(roleTrigger(role));
    });
    return labels;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAccounts.mockResolvedValue(accounts);
    mockGetSecurities.mockResolvedValue(securities);
    mockUpdateConfig.mockResolvedValue(gemReport());
    mockCreateSecurity.mockResolvedValue({
      id: "sec-cspx",
      symbol: "CSPX",
      name: "iShares Core S&P 500 UCITS ETF",
      isActive: true,
    });
  });

  /**
   * Invariant: a failed prerequisite is shown as a failure, not as a form
   * with nothing to choose from.
   * Canonical adversarial input: a rejected lookup where the success shape is
   * a list.
   * Minimal mutation: drop the `lookupError` branch and let the memos read
   * `data?.accounts ?? []`.
   * Test that fails under it: this one -- Save is on screen and live.
   */
  it("reports a failed lookup rather than an empty form", async () => {
    mockGetAccounts.mockRejectedValue(new Error("offline"));
    await renderForm();
    await act(async () => {});

    await waitFor(() =>
      expect(
        screen.getByText(
          "Your accounts and instruments could not be loaded, so the settings cannot be edited safely.",
        ),
      ).toBeInTheDocument(),
    );
    // No pick-lists offering nothing, and nothing to save over the stored
    // configuration with.
    expect(
      screen.queryByLabelText("Strategy accounts"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Try Again" }),
    ).toBeInTheDocument();
  });

  it("retries the lookup and renders the form once it succeeds", async () => {
    mockGetSecurities.mockRejectedValueOnce(new Error("offline"));
    await renderForm();
    await act(async () => {});
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Try Again" }),
      ).toBeInTheDocument(),
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    });

    await waitFor(() =>
      expect(screen.getByLabelText("Strategy accounts")).toBeInTheDocument(),
    );
  });

  it("prefills the stored configuration", async () => {
    await renderForm();

    expect(screen.getByLabelText("Strategy accounts")).toHaveTextContent(
      "Broker IRA",
    );
    expect(screen.getByLabelText("Evaluation frequency")).toHaveValue(
      "MONTHLY",
    );
    // NumericInput and CurrencyInput are text fields that format on blur, so
    // the values read back as the formatted strings, not as numbers.
    expect(screen.getByLabelText("Momentum window (months)")).toHaveValue("12");
    expect(screen.getByLabelText("Tax Rate (optional)")).toHaveValue("19.00");
    expect(screen.getByLabelText("Commission per Trade (optional)")).toHaveValue("29.90");
    expect(screen.getByLabelText("Text to show for that link")).toHaveValue(
      "example.test/gem",
    );
    expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
  });

  it("offers only brokerage investment accounts and active securities", async () => {
    await renderForm();

    // The account picker is a multi-select, so its options live in a dropdown.
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Strategy accounts"));
    });
    expect(
      screen
        .getAllByRole("checkbox")
        .map((box) => box.closest("label")?.textContent),
    ).toEqual(["Broker IRA", "Broker Taxable"]);

    // Suggestions for this role first, one per region, then what is held.
    expect(await instrumentOptions("Emerging markets")).toEqual([
      "EEMiShares MSCI Emerging Markets ETF · NYSEARCA",
      // The recommendation the portfolio already holds is still a
      // recommendation -- picking it assigns the instrument instead of
      // opening the create form, and it says so rather than dropping out of
      // the group and leaving the role's own fund unmarked in the long list
      // of everything owned.
      "EMIMiShares MSCI EM IMI ETF · already in your instruments",
      "No instrument",
      "SPY — SPDR S&P 500 ETF",
      "EMIM — iShares MSCI EM IMI ETF",
    ]);
  });

  it("assigns an owned instrument straight from the suggestions", async () => {
    await renderForm();

    await pickInstrument("Emerging markets", "No instrument");
    expect(roleTrigger("Emerging markets")).toHaveTextContent("No instrument");

    await pickInstrument(
      "Emerging markets",
      "EMIMiShares MSCI EM IMI ETF · already in your instruments",
    );

    // Assigned, not sent to the create form: the instrument exists.
    expect(roleTrigger("Emerging markets")).toHaveTextContent("EMIM");
    expect(mockCreateSecurity).not.toHaveBeenCalled();
  });

  /**
   * Invariant: a suggestion whose symbol the user already holds is offered as
   * that instrument, never as something to create.
   *
   * The picker used to require the exchange and the currency to agree too, on
   * the reasoning that CSPX on LSE is not CSPX on SIX. True of the world,
   * false of this application: `SecuritiesService.create` allows one security
   * per symbol per user, so the second listing cannot exist. The stricter
   * match therefore offered a create for an instrument that is already there,
   * and the server refused it every time -- "Security with symbol EXUS
   * already exists" on a portfolio holding EXUS.
   *
   * Minimal mutation: match on symbol + exchange + currency again.
   * Test that fails under it: this one -- the entry offers a create.
   */
  it("treats a held instrument as owned whatever exchange it was entered on", async () => {
    mockGetSecurities.mockResolvedValue([
      {
        id: "sec-emim-six",
        symbol: "EMIM",
        name: "iShares MSCI EM IMI ETF",
        // Recorded on another exchange, in another currency -- and still the
        // only EMIM this portfolio can hold.
        exchange: "SIX",
        currencyCode: "CHF",
        isActive: true,
      },
    ]);
    await renderForm();

    await act(async () => {
      fireEvent.click(roleTrigger("Emerging markets"));
    });

    expect(
      screen.getByRole("option", {
        name: /EMIM.*already in your instruments/,
      }),
    ).toBeInTheDocument();
  });

  it("assigns a held instrument the pick-list hides because it is deactivated", async () => {
    // Reached only through its suggestion: deactivated, so it is not in "Your
    // instruments". Assigning it has to make it visible, or the field reads
    // "No instrument" over a real assignment.
    mockGetSecurities.mockResolvedValue([
      {
        id: "sec-emim-old",
        symbol: "EMIM",
        name: "iShares MSCI EM IMI ETF",
        exchange: "LSE",
        currencyCode: "USD",
        isActive: false,
      },
    ]);
    await renderForm({
      assets: gemAssets.map((asset) =>
        asset.role === "EM_EQUITY"
          ? { ...asset, securityId: null, symbol: null }
          : asset,
      ),
    });

    await pickInstrument(
      "Emerging markets",
      "EMIMiShares MSCI EM IMI ETF · already in your instruments",
    );

    expect(roleTrigger("Emerging markets")).toHaveTextContent("EMIM");
    expect(mockCreateSecurity).not.toHaveBeenCalled();
  });

  it("saves the assignments and hands the refreshed report back", async () => {
    const refreshed = gemReport();
    mockUpdateConfig.mockResolvedValue(refreshed);
    const { onSaved } = await renderForm();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Evaluation frequency"), {
        target: { value: "QUARTERLY" },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        accountIds: ["acct-1"],
        cadence: "QUARTERLY",
        lookbackMonths: 12,
        taxRatePercent: 19,
        commissionAmount: 29.9,
        rulesSourceLabel: "example.test/gem",
        assets: [
          { role: "US_EQUITY", securityId: "sec-spy" },
          { role: "EX_US_EQUITY", securityId: "sec-ewa" },
          { role: "EM_EQUITY", securityId: "sec-emim" },
          { role: "SAFE", securityId: "sec-ief" },
          { role: "RISK_FREE", securityId: "sec-bil" },
        ],
      }),
      "1Y",
      // The save names the scenario being edited; without it the server would
      // rewrite the user's oldest one instead.
      "strategy-1",
    );
    expect(mockToastSuccess).toHaveBeenCalledWith(
      "Strategy configuration saved.",
    );
    expect(onSaved).toHaveBeenCalledWith(refreshed);
  });

  it("clears a role, the accounts and a cost assumption", async () => {
    await renderForm();

    await pickInstrument("Safe asset", "No instrument");
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Commission per Trade (optional)"), {
        target: { value: "" },
      });
      fireEvent.click(screen.getByLabelText("Strategy accounts"));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    const [payload] = mockUpdateConfig.mock.calls[0];
    expect(payload.accountIds).toEqual([]);
    // Cleared, not zeroed -- a blank cost is unknown.
    expect(payload.commissionAmount).toBeNull();
    expect(payload.assets).toContainEqual({ role: "SAFE", securityId: null });
  });

  it("runs the strategy across several accounts at once", async () => {
    await renderForm();

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Strategy accounts"));
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Broker Taxable" }),
      );
    });
    // Both accounts now feed the strategy, so the trigger shows a count.
    expect(screen.getByLabelText("Strategy accounts")).toHaveTextContent(
      "2 selected",
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    const [payload] = mockUpdateConfig.mock.calls[0];
    expect(payload.accountIds).toEqual(["acct-1", "acct-2"]);
  });

  it("sends the range the page is showing so the refreshed report matches", async () => {
    await renderForm({ range: "MAX" });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });
    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.anything(),
      "MAX",
      "strategy-1",
    );
  });

  it("holds the momentum window at its minimum rather than accepting zero", async () => {
    // NumericInput enforces `min` as you type, so the invalid value never
    // reaches the form -- the field settles on 1 instead of erroring.
    await renderForm();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
        target: { value: "0" },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.objectContaining({ lookbackMonths: 1 }),
      "1Y",
      "strategy-1",
    );
  });

  it("rejects a momentum window longer than the schema allows", async () => {
    // The shared input has no maximum, so this one is the schema's to catch.
    await renderForm();

    await act(async () => {
      fireEvent.change(screen.getByLabelText("Momentum window (months)"), {
        target: { value: "999" },
      });
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });

  it("surfaces the server's reason for a rejected save", async () => {
    // The backend rejects an account or security that is not the caller's.
    mockUpdateConfig.mockRejectedValue({
      response: { data: { message: "Security not found" } },
    });
    const { onSaved } = await renderForm();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });
    await act(async () => {});

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith("Security not found"),
    );
    expect(onSaved).not.toHaveBeenCalled();
    // The entered values survive so the user can correct and retry.
    expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
  });

  it("falls back to its own message when the failure carries none", async () => {
    mockUpdateConfig.mockRejectedValue({});
    await renderForm();

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });
    await act(async () => {});

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        "Could not save the strategy configuration.",
      ),
    );
  });

  it("starts from an empty configuration for an unconfigured strategy", async () => {
    const report = gemReport({
      strategy: {
        ...gemReport().strategy,
        accounts: [],
        taxRatePercent: null,
        commissionAmount: null,
        rulesSourceUrl: null,
        rulesSourceLabel: null,
      },
    });
    await renderForm({
      strategy: report.strategy,
      assets: gemAssets.map((asset) => ({
        ...asset,
        securityId: null,
        symbol: null,
      })),
    });

    expect(screen.getByLabelText("Strategy accounts")).toHaveTextContent(
      "No account assigned",
    );
    expect(screen.getByLabelText("Tax Rate (optional)")).toHaveValue("");
    expect(roleTrigger("S&P 500")).toHaveTextContent("No instrument");
    expect(
      screen.getByText(/Assign an ETF or fund to each role/),
    ).toBeInTheDocument();
  });

  it("sends no scenario id on the very first save", async () => {
    // Before the first save there is no stored strategy, so its id is null.
    // Sending a stand-in in its place put a non-UUID on the query string,
    // which the endpoint rejects -- every new user's first save failed.
    await renderForm({
      strategy: { ...gemReport().strategy, id: null },
    });

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );
    });

    expect(mockUpdateConfig).toHaveBeenCalledWith(
      expect.anything(),
      "1Y",
      undefined,
    );
  });

  describe("filling the missing roles", () => {
    const unconfigured = () => ({
      strategy: { ...gemReport().strategy, accounts: [] },
      assets: gemAssets.map((asset) => ({
        ...asset,
        securityId: null,
        symbol: null,
      })),
    });

    beforeEach(() => {
      mockCreateSecurity.mockImplementation(
        (data: { symbol: string; name: string }) =>
          Promise.resolve({
            id: `sec-new-${data.symbol}`,
            ...data,
            isActive: true,
          }),
      );
    });

    it("creates and assigns an instrument for every unassigned role", async () => {
      // A portfolio that has never held a GEM instrument: only SPY is on file.
      mockGetSecurities.mockResolvedValue([securities[0]]);
      await renderForm(unconfigured());

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the 5 missing/ }),
        );
      });

      // SPY already exists, so only the other three are created.
      expect(
        mockCreateSecurity.mock.calls.map(([data]) => data.symbol),
      ).toEqual(["VEU", "EEM", "AGG", "BIL"]);
      expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
      expect(roleTrigger("Developed markets ex-US")).toHaveTextContent("VEU");
      expect(roleTrigger("Emerging markets")).toHaveTextContent("EEM");
      // The two defensive roles get different funds: the bond fund is what a
      // RISK-OFF period holds, T-bills are only the yardstick.
      expect(roleTrigger("Safe asset")).toHaveTextContent("AGG");
      expect(roleTrigger("Risk-free benchmark")).toHaveTextContent("BIL");
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "5 instruments added. Save the configuration to load their prices and evaluate the first signal.",
      );
      // Nothing is saved until the user reviews the picks.
      expect(mockUpdateConfig).not.toHaveBeenCalled();
    });

    it("adds the UCITS listings when Europe is chosen", async () => {
      // The same index is a different fund depending on the broker: the US
      // listings the button used to add unconditionally cannot be bought at a
      // European broker at all, which made the one-click path useless to
      // exactly the users it exists for.
      mockGetSecurities.mockResolvedValue([]);
      await renderForm(unconfigured());

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Listings to add"), {
          target: { value: "EUROPE" },
        });
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the 5 missing/ }),
        );
      });

      expect(
        mockCreateSecurity.mock.calls.map(([data]) => data.symbol),
      ).toEqual(["CSPX", "EXUS", "EMIM", "AGGG", "IB01"]);
    });

    it("names the listings it is about to add", async () => {
      mockGetSecurities.mockResolvedValue([]);
      await renderForm(unconfigured());

      expect(screen.getByText(/SPY, VEU, EEM, AGG, BIL/)).toBeInTheDocument();

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Listings to add"), {
          target: { value: "EUROPE" },
        });
      });

      expect(
        screen.getByText(/CSPX, EXUS, EMIM, AGGG, IB01/),
      ).toBeInTheDocument();
    });

    it("leaves the roles the user already assigned alone", async () => {
      await renderForm();

      // The fixture assigns every role, so there is nothing to offer.
      expect(
        screen.queryByRole("button", { name: /missing instrument/ }),
      ).toBeNull();

      await pickInstrument("Safe asset", "No instrument");
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the missing instrument/ }),
        );
      });

      expect(
        mockCreateSecurity.mock.calls.map(([data]) => data.symbol),
      ).toEqual(["AGG"]);
      expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
      expect(roleTrigger("Safe asset")).toHaveTextContent("AGG");
    });

    it("reuses a deactivated instrument instead of dropping the assignment", async () => {
      // The symbol is taken, so creating it again would be rejected; the
      // deactivated security has to become selectable and actually get picked.
      mockGetSecurities.mockResolvedValue([
        {
          id: "sec-old-spy",
          symbol: "SPY",
          name: "SPDR S&P 500 ETF",
          exchange: "NYSEARCA",
          currencyCode: "USD",
          isActive: false,
        },
      ]);
      await renderForm(unconfigured());

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the 5 missing/ }),
        );
      });

      expect(
        mockCreateSecurity.mock.calls.map(([data]) => data.symbol),
      ).toEqual(["VEU", "EEM", "AGG", "BIL"]);
      expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
    });

    it("reuses a held instrument whose exchange differs from the suggestion", async () => {
      /**
       * Invariant: the picker's "you already have this" is the server's own
       * uniqueness rule -- one security per symbol per user.
       * Canonical adversarial input: the same ticker recorded with another
       * exchange, or with none, which is how an instrument entered by hand or
       * through an import usually looks.
       * Minimal mutation: key `ownedBySymbol` on symbol + exchange + currency
       * again.
       * Test that fails under it: this one -- EXUS is sent to `createSecurity`
       * and the server answers "Security with symbol EXUS already exists".
       */
      mockGetSecurities.mockResolvedValue([
        {
          id: "sec-exus",
          symbol: "EXUS",
          name: "Xtrackers MSCI World ex USA UCITS ETF",
          // Held on another exchange, priced in another currency: still the
          // only EXUS this user can have.
          exchange: "GPW",
          currencyCode: "PLN",
          isActive: true,
        },
      ]);
      await renderForm(unconfigured());

      await act(async () => {
        fireEvent.change(screen.getByLabelText("Listings to add"), {
          target: { value: "EUROPE" },
        });
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the 5 missing/ }),
        );
      });

      expect(
        mockCreateSecurity.mock.calls.map(([data]) => data.symbol),
      ).toEqual(["CSPX", "EMIM", "AGGG", "IB01"]);
      expect(roleTrigger("Developed markets ex-US")).toHaveTextContent("EXUS");
    });

    it("asks for the deactivated instruments too", async () => {
      // The pick-list hides them, but they hold their symbols against the
      // server's uniqueness check, so the question "do I already have this"
      // cannot be answered from the active ones alone.
      mockGetSecurities.mockResolvedValue([]);
      await renderForm(unconfigured());

      expect(mockGetSecurities).toHaveBeenCalledWith(true);
    });

    it("keeps an assigned instrument selectable after it is deactivated", async () => {
      // Otherwise the select silently falls back to "No instrument" and saving
      // clears a role the user never touched.
      mockGetSecurities.mockResolvedValue([
        {
          id: "sec-spy",
          symbol: "SPY",
          name: "SPDR S&P 500 ETF",
          exchange: "NYSEARCA",
          currencyCode: "USD",
          isActive: false,
        },
      ]);
      await renderForm();

      expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Save configuration" }),
        );
      });
      const [payload] = mockUpdateConfig.mock.calls[0];
      expect(payload.assets).toContainEqual({
        role: "US_EQUITY",
        securityId: "sec-spy",
      });
    });

    it("reports a failure and keeps what it managed to create", async () => {
      mockGetSecurities.mockResolvedValue([]);
      // The first instrument is created, the next one is rejected.
      mockCreateSecurity
        .mockResolvedValueOnce({
          id: "sec-new-SPY",
          symbol: "SPY",
          name: "SPDR S&P 500 ETF Trust",
          isActive: true,
        })
        .mockRejectedValue({
          response: { data: { message: "Symbol not recognized" } },
        });
      await renderForm(unconfigured());

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: /Add the 5 missing/ }),
        );
      });
      await act(async () => {});

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Symbol not recognized"),
      );
      // The created instrument is assigned, so a retry reuses it instead of
      // adding the same symbol twice.
      expect(roleTrigger("S&P 500")).toHaveTextContent("SPY");
      expect(roleTrigger("Safe asset")).toHaveTextContent("No instrument");
      expect(
        screen.getByRole("button", { name: /Add the 4 missing/ }),
      ).toBeInTheDocument();
    });
  });

  it("shows a skeleton while the pick-lists load", async () => {
    let resolve: (value: unknown) => void = () => {};
    mockGetAccounts.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { container } = await renderForm();
    expect(container.querySelector(".animate-pulse")).toBeInTheDocument();
    await act(async () => {
      resolve(accounts);
    });
  });

  describe("adding a missing instrument", () => {
    it("creates one from the role that has none and assigns it", async () => {
      await renderForm({
        assets: gemAssets.map((asset) => ({
          ...asset,
          securityId: null,
          symbol: null,
        })),
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Add an instrument for S&P 500" }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "stub-create-security" }),
        );
      });

      expect(mockCreateSecurity).toHaveBeenCalledWith({
        symbol: "CSPX",
        name: "iShares Core S&P 500 UCITS ETF",
      });
      expect(mockToastSuccess).toHaveBeenCalledWith(
        "CSPX created and assigned.",
      );
      // Assigned to the role that opened the modal, and offered to the others.
      expect(roleTrigger("S&P 500")).toHaveTextContent("CSPX");
      expect(await instrumentOptions("Safe asset")).toContain(
        "CSPX — iShares Core S&P 500 UCITS ETF",
      );
    });

    it("saves the newly created instrument with the configuration", async () => {
      await renderForm({
        assets: gemAssets.map((asset) => ({
          ...asset,
          securityId: null,
          symbol: null,
        })),
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", {
            name: "Add an instrument for Safe asset",
          }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "stub-create-security" }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Save configuration" }),
        );
      });

      const [payload] = mockUpdateConfig.mock.calls[0];
      expect(payload.assets).toContainEqual({
        role: "SAFE",
        securityId: "sec-cspx",
      });
    });

    it("leaves the role untouched when the creation fails", async () => {
      mockCreateSecurity.mockRejectedValue({
        response: { data: { message: "Symbol already exists" } },
      });
      await renderForm({
        assets: gemAssets.map((asset) => ({
          ...asset,
          securityId: null,
          symbol: null,
        })),
      });

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Add an instrument for S&P 500" }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "stub-create-security" }),
        );
      });
      await act(async () => {});

      await waitFor(() =>
        expect(mockToastError).toHaveBeenCalledWith("Symbol already exists"),
      );
      expect(roleTrigger("S&P 500")).toHaveTextContent("No instrument");
    });

    it("closes the modal on cancel without creating anything", async () => {
      await renderForm();

      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Add an instrument for S&P 500" }),
        );
      });
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "stub-cancel-security" }),
        );
      });

      expect(mockCreateSecurity).not.toHaveBeenCalled();
      expect(
        screen.queryByRole("button", { name: "stub-create-security" }),
      ).not.toBeInTheDocument();
    });
  });
});
