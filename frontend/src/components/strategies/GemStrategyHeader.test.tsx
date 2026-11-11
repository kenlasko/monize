import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@/test/render";
import { GemStrategyHeader } from "./GemStrategyHeader";

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/reports/gem-strategy",
  useSearchParams: () => new URLSearchParams(),
}));

// The report switcher lists the user's saved reports beside the built-in ones.
vi.mock("@/lib/custom-reports", () => ({
  customReportsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/lib/investment-reports", () => ({
  investmentReportsApi: { getAll: vi.fn().mockResolvedValue([]) },
}));

describe("GemStrategyHeader", () => {
  beforeEach(() => {
    push.mockClear();
  });

  const baseProps = {
    strategyId: "strategy-1",
    strategyName: "GEM Strategy",
    scenarios: [{ id: "strategy-1", name: "GEM Strategy" }],
    onSelectScenario: vi.fn(),
    onCreateScenario: vi.fn().mockResolvedValue("done" as const),
    onDeleteScenario: vi.fn().mockResolvedValue("done" as const),
    scenarioBusy: false,
    cadence: "MONTHLY" as const,
    lookbackMonths: 12,
    nextEvaluationOn: "2025-08-31",
    daysUntilNextEvaluation: 28,
  };

  /**
   * `ReportSwitcher` beside the title loads the user's saved reports on mount,
   * so every render here has async work behind it -- even the tests that only
   * assert on static copy. Rendering outside act leaves those state updates
   * unwrapped.
   */
  const renderHeader = async (props: Record<string, unknown> = {}) => {
    await act(async () => {
      render(
        <GemStrategyHeader
          {...baseProps}
          onEditSettings={vi.fn()}
          {...props}
        />,
      );
    });
  };

  it("shows the way back, title, cadence and days remaining", async () => {
    await renderHeader();

    // The same back link the other report pages carry, above the title.
    expect(
      screen.getByRole("link", { name: "Back to Reports" }),
    ).toHaveAttribute("href", "/reports");
    expect(
      screen.getByRole("heading", { level: 1, name: /GEM Strategy/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Global equities momentum – equities versus a safe asset",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Evaluation frequency: monthly"),
    ).toBeInTheDocument();
    expect(screen.getByText(/in 28 days/)).toBeInTheDocument();
  });

  /**
   * Invariant: copy naming the momentum window names the configured one.
   * Canonical adversarial input: a configuration away from the default.
   * Minimal mutation: hardcode 12 in the `explainer` catalog string.
   * Test that fails under it: this one.
   */
  it("explains the strategy with the window it is actually run on", async () => {
    await renderHeader({ lookbackMonths: 6 });

    // The tooltip's text is on the trigger, so it is readable without hover.
    const explainer = screen.getByLabelText(/Global Equities Momentum/);
    expect(explainer).toHaveAccessibleName(
      expect.stringContaining("6-month return"),
    );
    expect(explainer).not.toHaveAccessibleName(
      expect.stringContaining("12-month return"),
    );
  });

  it("omits the day count when it is unknown", async () => {
    await renderHeader({ daysUntilNextEvaluation: null });
    expect(screen.getByText(/Next evaluation:/)).toBeInTheDocument();
    expect(screen.queryByText(/in 28 days/)).not.toBeInTheDocument();
  });

  it("says the evaluation is unscheduled without a date", async () => {
    await renderHeader({ nextEvaluationOn: null });
    expect(
      screen.getByText("Next evaluation not scheduled"),
    ).toBeInTheDocument();
  });

  /**
   * The page carries two switchers, one inside the other's subject: the caret
   * beside the title moves to another report, the scenario control moves within
   * this one. They sit on the same line, so each has to say which it is -- and
   * the report caret has to be there at all, which is the whole point of the
   * section reading the same way on every page.
   */
  describe("the two switchers on the title line", () => {
    const twoScenarios = [
      { id: "strategy-1", name: "GEM Strategy" },
      { id: "strategy-2", name: "GEM 6-month" },
    ];

    it("switches reports from the caret beside the title", async () => {
      await renderHeader();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Switch to another report" }),
        );
      });
      // Grouped by section, like every other report page's caret.
      const budget = screen.getByRole("group", { name: "Budget" });
      fireEvent.click(
        within(budget).getByRole("menuitem", { name: /Savings Rate/ }),
      );
      expect(push).toHaveBeenCalledWith("/reports/savings-rate");
    });

    it("opens on this report, marked as current, without navigating to it", async () => {
      await renderHeader();
      await act(async () => {
        fireEvent.click(
          screen.getByRole("button", { name: "Switch to another report" }),
        );
      });
      const current = screen.getByRole("menuitem", { name: /^GEM Strategy/ });
      expect(current).toHaveAttribute("aria-current", "true");
      fireEvent.click(current);
      expect(push).not.toHaveBeenCalled();
    });

    it("names the scenario control, so the second caret is not a mystery", async () => {
      const onSelectScenario = vi.fn();
      await renderHeader({ scenarios: twoScenarios, onSelectScenario });
      const scenarioTrigger = screen.getByRole("button", {
        name: "Switch scenario",
      });
      expect(scenarioTrigger).toHaveTextContent("Scenario");
      // And it still switches scenarios rather than navigating anywhere.
      fireEvent.click(scenarioTrigger);
      fireEvent.click(screen.getByRole("menuitem", { name: /GEM 6-month/ }));
      expect(onSelectScenario).toHaveBeenCalledWith("strategy-2");
      expect(push).not.toHaveBeenCalled();
    });
  });

  it("reports the settings request", async () => {
    const onEditSettings = vi.fn();
    await renderHeader({ onEditSettings });
    fireEvent.click(screen.getByRole("button", { name: /Edit settings/ }));
    expect(onEditSettings).toHaveBeenCalledOnce();
  });
});
