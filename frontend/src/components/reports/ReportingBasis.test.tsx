import { act, fireEvent, render, screen } from "@/test/render";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ReportingBasisScope,
  ReportingBasisControl,
  useReportingBasis,
  useReportingRouter,
  SELECTABLE_REPORT_IDS,
  CASH_REPORT_IDS,
} from "./ReportingBasis";
import { usePreferencesStore } from "@/store/preferencesStore";
import { useAuthStore } from "@/store/authStore";
import type { User, UserPreferences } from "@/types/auth";
function Value() {
  const basis = useReportingBasis();
  return <output>{basis}</output>;
}
function View({ surface = "report" }: { surface?: string }) {
  return (
    <ReportingBasisScope surface={surface}>
      <ReportingBasisControl />
      <Value />
    </ReportingBasisScope>
  );
}
beforeEach(() => {
  useAuthStore.setState({
    user: { id: "owner" } as User,
    actingAsUserId: null,
  });
  usePreferencesStore.setState({
    preferences: { accrualEnabled: true, reportingBasis: "accrual" } as UserPreferences,
  });
});
it("defaults to accrual and permits a per-view cash override without persisting it", () => {
  render(<View />);
  expect(screen.getByRole("status")).toHaveTextContent("accrual");
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("cash");
  expect(usePreferencesStore.getState().preferences).toEqual({
    accrualEnabled: true,
    reportingBasis: "accrual",
  });
});
it('uses cash and hides the control when accrual accounting is disabled', () => {
  usePreferencesStore.setState({
    preferences: { accrualEnabled: false, reportingBasis: 'accrual' } as UserPreferences,
  });
  render(<View />);
  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveTextContent('cash');
});
it("follows the user default until overridden and resets explicitly", () => {
  render(<View />);
  act(() =>
    usePreferencesStore
      .getState()
      .updatePreferences({ reportingBasis: "cash" }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("cash");
  fireEvent.click(
    screen.getByRole("button", { name: /^Accrual(?: \(user default\))?$/ }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("accrual");
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  expect(screen.getByRole("status")).toHaveTextContent("cash");
});
it("does not apply another report or acting context override", () => {
  const { rerender } = render(<View />);
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  rerender(<View surface="other" />);
  expect(screen.getByRole("status")).toHaveTextContent("accrual");
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  act(() => useAuthStore.setState({ actingAsUserId: "delegated-owner" }));
  expect(screen.getByRole("status")).toHaveTextContent("accrual");
});
it("keeps cash-only reports out of the selectable report set", () => {
  expect(SELECTABLE_REPORT_IDS.size).toBe(18);
  for (const id of CASH_REPORT_IDS)
    expect(SELECTABLE_REPORT_IDS.has(id)).toBe(false);
});

it("preserves the report filter controls while the basis changes", () => {
  render(
    <ReportingBasisScope surface="report">
      <ReportingBasisControl />
      <input aria-label="Period" defaultValue="2026-01" />
      <Value />
    </ReportingBasisScope>,
  );
  fireEvent.change(screen.getByLabelText("Period"), {
    target: { value: "2026-02" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  expect(screen.getByLabelText("Period")).toHaveValue("2026-02");
});

function Drilldown() {
  const router = useReportingRouter();
  return (
    <button
      onClick={() =>
        router.push(
          "/transactions?categoryId=11111111-1111-4111-8111-111111111111&startDate=2026-01-01&endDate=2026-01-31",
        )
      }
    >
      Expand
    </button>
  );
}
it("opens effective-period components and closes the old-basis dialog on switching to cash", async () => {
  const { reportingDetailsApi } = await import("@/lib/reporting-details");
  const get = vi.spyOn(reportingDetailsApi, "get").mockResolvedValue({
    basis: "accrual",
    currency: "USD",
    readOnly: true,
    fxComplete: true,
    total: 0,
    knownSubtotal: 0,
    missingRatePairs: [],
    rows: [],
  });
  render(
    <ReportingBasisScope surface="drilldown">
      <ReportingBasisControl />
      <Drilldown />
    </ReportingBasisScope>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  await screen.findByRole("dialog");
  expect(get).toHaveBeenCalledWith(
    expect.objectContaining({
      basis: "accrual",
      startDate: "2026-01-01",
      categoryIds: ["11111111-1111-4111-8111-111111111111"],
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /^Cash(?: \(user default\))?$/ }),
  );
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  get.mockRestore();
});

it("exposes two pressed-state buttons and marks only the saved default", () => {
  render(<View />);
  const cash = screen.getByRole("button", { name: "Cash" });
  const accrual = screen.getByRole("button", {
    name: "Accrual (user default)",
  });
  expect(accrual).toHaveAttribute("aria-pressed", "true");
  expect(cash).toHaveAttribute("aria-pressed", "false");
  fireEvent.click(cash);
  expect(cash).toHaveAttribute("aria-pressed", "true");
  expect(accrual).toHaveAttribute("aria-pressed", "false");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  fireEvent.click(accrual);
  act(() =>
    usePreferencesStore
      .getState()
      .updatePreferences({ reportingBasis: "cash" }),
  );
  expect(
    screen.getByRole("button", { name: "Cash (user default)" }),
  ).toHaveAttribute("aria-pressed", "true");
});

it("allows an explicit cash parent arrival while marking the saved accrual default", () => {
  render(
    <ReportingBasisScope surface="transactions" initialBasis="cash">
      <ReportingBasisControl />
      <Value />
    </ReportingBasisScope>,
  );
  expect(screen.getByRole("button", { name: "Cash" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(
    screen.getByRole("button", { name: "Accrual (user default)" }),
  ).toHaveAttribute("aria-pressed", "false");
});

it("defaults to cash when no reporting preference has been saved", () => {
  usePreferencesStore.setState({preferences: {accrualEnabled: true} as UserPreferences});
  render(<View />);
  expect(screen.getByRole("status")).toHaveTextContent("cash");
});

it("honors feature-off even when a caller supplies a fixed accrual view", () => {
  usePreferencesStore.setState({preferences:{accrualEnabled:false,reportingBasis:"accrual"} as UserPreferences});
  render(<ReportingBasisScope surface="fixed" fixedBasis="accrual"><Value /></ReportingBasisScope>);
  expect(screen.getByRole("status")).toHaveTextContent("cash");
});
