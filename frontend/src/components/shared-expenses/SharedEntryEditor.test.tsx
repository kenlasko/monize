import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { SharedEntryEditor } from "./SharedEntryEditor";
import { sharedExpensesApi } from "@/lib/shared-expenses";
import { exchangeRatesApi } from "@/lib/exchange-rates";
import {
  sharedEntryFixture,
  sharedGroupFixture,
} from "./__fixtures__/shared-fixtures";
import type { SharedEntry } from "@/types/shared-expense";

vi.mock("@/lib/shared-expenses", async (original) => ({
  ...(await original<typeof import("@/lib/shared-expenses")>()),
  sharedExpensesApi: { preview: vi.fn(), saveEntry: vi.fn() },
}));
vi.mock("@/lib/exchange-rates", async (original) => ({
  ...(await original<typeof import("@/lib/exchange-rates")>()),
  exchangeRatesApi: { getCurrencies: vi.fn() },
}));
vi.mock("@/hooks/useFinancialToday", () => ({
  useFinancialToday: () => "2026-10-25",
}));
vi.mock("next/dynamic", () => ({ default: () => () => null }));
describe("SharedEntryEditor", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(sharedExpensesApi.preview)
      .mockReset()
      .mockResolvedValue(sharedEntryFixture());
    vi.mocked(sharedExpensesApi.saveEntry).mockReset();
    vi.mocked(exchangeRatesApi.getCurrencies).mockResolvedValue([
      { code: "PLN", name: "Polish zloty", decimalPlaces: 2, symbol: "zł" },
    ] as never);
  });
  afterEach(() => vi.useRealTimers());
  const advancePreview = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  async function setup() {
    const onSaved = vi.fn(),
      onClose = vi.fn();
    await act(async () => {
      render(
        <SharedEntryEditor
          group={sharedGroupFixture()}
          onSaved={onSaved}
          onClose={onClose}
        />,
      );
    });
    expect(
      screen.getAllByRole("button", { name: "Change entry currency" })[0],
    ).toBeInTheDocument();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Description"), {
        target: { value: "Dinner" },
      });
      fireEvent.change(screen.getByLabelText("Amount"), {
        target: { value: "300" },
      });
    });
    return { onSaved, onClose };
  }
  it("accepts only the preview for the current draft, and saves no private bank movement", async () => {
    let resolve!: (value: SharedEntry) => void;
    vi.mocked(sharedExpensesApi.preview)
      .mockReturnValueOnce(
        new Promise((done) => {
          resolve = done;
        }),
      )
      .mockResolvedValueOnce(
        sharedEntryFixture({
          originalAmount: "120.0000",
          groupAmount: "120.0000",
        }),
      );
    vi.mocked(sharedExpensesApi.saveEntry).mockResolvedValue(
      sharedEntryFixture(),
    );
    const { onSaved, onClose } = await setup();
    await advancePreview();
    expect(sharedExpensesApi.preview).toHaveBeenCalledOnce();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Amount"), {
        target: { value: "120" },
      });
    });
    await act(async () => resolve(sharedEntryFixture()));
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    const sent = vi.mocked(sharedExpensesApi.saveEntry).mock.calls[0][1];
    expect(sent).toMatchObject({
      amount: "120",
      contributions: [{ participantId: "me", value: "120" }],
      previewFingerprint: "preview",
    });
    expect(sent).not.toHaveProperty("bankAccountId");
    expect(sent).not.toHaveProperty("bankTransactionId");
  });
  it("keeps the draft and command identity after a lost save response", async () => {
    vi.mocked(sharedExpensesApi.preview).mockResolvedValue(
      sharedEntryFixture({
        ownEffect: {
          cash: "-300.0000",
          originalCash: "-300.0000",
          personal: "-150.0000",
          position: "150.0000",
          originalCurrency: "PLN",
        },
      }),
    );
    vi.mocked(sharedExpensesApi.saveEntry)
      .mockRejectedValueOnce(new Error("Connection interrupted"))
      .mockResolvedValueOnce(sharedEntryFixture());
    const { onSaved } = await setup();
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByText("Your Cost", { exact: false })).toHaveTextContent(
      /150/,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Connection interrupted",
    );
    expect(screen.getByLabelText("Description")).toHaveValue("Dinner");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(onSaved).toHaveBeenCalledOnce();
    expect(vi.mocked(sharedExpensesApi.saveEntry).mock.calls[1]).toEqual(
      vi.mocked(sharedExpensesApi.saveEntry).mock.calls[0],
    );
    expect(sharedExpensesApi.preview).toHaveBeenCalledOnce();
  });
  it("warns before leaving while an unchanged entry is still saving", async () => {
    let finish!: (entry: SharedEntry) => void;
    vi.mocked(sharedExpensesApi.saveEntry).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const onClose = vi.fn();
    await act(async () => {
      render(
        <SharedEntryEditor
          group={sharedGroupFixture()}
          entry={sharedEntryFixture()}
          onSaved={vi.fn()}
          onClose={onClose}
        />,
      );
    });
    await advancePreview();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));
    });
    expect(sharedExpensesApi.saveEntry).toHaveBeenCalledOnce();
    const leaving = new Event("beforeunload", { cancelable: true });
    fireEvent(window, leaving);
    expect(leaving.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => finish(sharedEntryFixture()));
    expect(onClose).toHaveBeenCalledOnce();
  });
  it("does not replace a newer preview when an older request finishes last", async () => {
    let resolveOld!: (value: SharedEntry) => void;
    vi.mocked(sharedExpensesApi.preview)
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce(
        sharedEntryFixture({
          previewFingerprint: "current-120",
          originalAmount: "120.0000",
        }),
      );
    vi.mocked(sharedExpensesApi.saveEntry).mockResolvedValue(
      sharedEntryFixture(),
    );
    await setup();
    await advancePreview();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Amount"), {
        target: { value: "120" },
      });
    });
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await act(async () => {
      resolveOld(sharedEntryFixture({ previewFingerprint: "old-300" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
    });
    expect(
      vi.mocked(sharedExpensesApi.saveEntry).mock.calls[0][1],
    ).toMatchObject({ amount: "120", previewFingerprint: "current-120" });
  });
  it("keeps failed preview values as a draft and offers another preview", async () => {
    vi.mocked(sharedExpensesApi.preview).mockRejectedValue(
      new Error("Choose a rate"),
    );
    await setup();
    await advancePreview();
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a rate");
    expect(sharedExpensesApi.saveEntry).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByLabelText("Amount")).toHaveValue("300.00");
    vi.mocked(sharedExpensesApi.preview).mockResolvedValue(
      sharedEntryFixture(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Try Again" }));
    });
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(sharedExpensesApi.saveEntry).not.toHaveBeenCalled();
  });
  it("waits for a foreign currency's precision before allowing money input", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof exchangeRatesApi.getCurrencies>>,
    ) => void;
    vi.mocked(exchangeRatesApi.getCurrencies).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    await act(async () => {
      render(
        <SharedEntryEditor
          group={sharedGroupFixture()}
          entry={sharedEntryFixture({
            currencyCode: "KWD",
            originalAmount: "1.0010",
          })}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    expect(screen.getByLabelText("Amount")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Change Split" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "More than one person paid" }),
      );
    });
    expect(screen.getByLabelText("Amount paid by Me")).toBeDisabled();
    await act(async () =>
      resolve([
        { code: "KWD", name: "Kuwaiti dinar", decimalPlaces: 3, symbol: "KWD" },
      ] as never),
    );
    expect(screen.getByLabelText("Amount")).toBeEnabled();
    expect(screen.getByLabelText("Amount")).toHaveValue("1.001");
    expect(screen.getByLabelText("Amount paid by Me")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Change Split" })).toBeEnabled();
  });
  it("previews a routine expense automatically but writes only after Save", async () => {
    await setup();
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(sharedExpensesApi.preview).toHaveBeenCalledOnce();
    expect(sharedExpensesApi.saveEntry).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "Review Split" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("switch", { name: /Also record this in my finances/ }),
    ).not.toBeInTheDocument();
  });
  it("explains an exact split made invalid by changing the total", async () => {
    await act(async () => {
      render(
        <SharedEntryEditor
          group={sharedGroupFixture()}
          initialValues={{
            title: "Dinner",
            amount: "330",
            splitMode: "EXACT",
            shares: [
              { participantId: "me", value: "150" },
              { participantId: "anna", value: "150" },
            ],
            contributions: [{ participantId: "me", value: "330" }],
          }}
          onSaved={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    expect(
      screen.getAllByRole("button", { name: "Change entry currency" })[0],
    ).toBeInTheDocument();
    expect(
      screen.getByText("The amount changed. Review the split before saving."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(sharedExpensesApi.preview).not.toHaveBeenCalled();
    expect(sharedExpensesApi.saveEntry).not.toHaveBeenCalled();
  });
  it("names incomplete contributions and makes returning to one payer explicit", async () => {
    await setup();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "More than one person paid" }),
      );
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Amount paid by Me"), {
        target: { value: "200" },
      });
    });
    expect(
      screen.getByText(
        "The amounts paid or received must add up to the amount above.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use One Person" }));
    });
    expect(screen.getByLabelText("Paid By")).toHaveValue("me");
    await advancePreview();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    expect(
      vi.mocked(sharedExpensesApi.preview).mock.lastCall?.[1].contributions,
    ).toEqual([{ participantId: "me", value: "300" }]);
  });
});
