import { describe, it, expect } from "vitest";
import { render, screen } from "@/test/render";
import {
  GemBadge,
  GemBar,
  GemCard,
  GemDonut,
  GemEmptyState,
  GemSigned,
  GemStatRow,
  GemSwatch,
  GemUnknown,
  GemValue,
} from "./GemPrimitives";

describe("GemPrimitives", () => {
  it("names a card section and renders its header extras", () => {
    render(
      <GemCard
        title="Current signal"
        hint="Explains the signal"
        headerRight={<span>RISK-ON</span>}
      >
        <p>body</p>
      </GemCard>,
    );
    expect(
      screen.getByRole("region", { name: /Current signal/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("RISK-ON")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("renders an untitled card body", () => {
    render(
      <GemCard ariaLabel="Bare card">
        <p>only body</p>
      </GemCard>,
    );
    expect(
      screen.getByRole("region", { name: "Bare card" }),
    ).toBeInTheDocument();
  });

  it("spells out an unknown value for screen readers", () => {
    render(<GemUnknown />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("uses a custom unknown label when given one", () => {
    render(<GemUnknown label="Transfer value not available" />);
    expect(
      screen.getByText("Transfer value not available"),
    ).toBeInTheDocument();
  });

  it("renders a known value and falls back for an unknown one", () => {
    const { rerender } = render(
      <GemValue value={12}>
        {(value) => <span>value is {value}</span>}
      </GemValue>,
    );
    expect(screen.getByText(/value is 12/)).toBeInTheDocument();
    rerender(
      <GemValue value={null}>
        {(value) => <span>value is {value}</span>}
      </GemValue>,
    );
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("signs a figure and tones it, or marks it unknown", () => {
    const format = (value: number) =>
      `${value >= 0 ? "+" : "-"}${Math.abs(value)}%`;
    const { rerender } = render(<GemSigned value={5} format={format} />);
    expect(screen.getByText("+5%")).toHaveClass("text-green-600");

    rerender(<GemSigned value={-5} format={format} />);
    expect(screen.getByText("-5%")).toHaveClass("text-red-600");

    rerender(<GemSigned value={-5} format={format} neutral />);
    expect(screen.getByText("-5%")).not.toHaveClass("text-red-600");

    rerender(<GemSigned value={null} format={format} />);
    expect(screen.getByText("Not available")).toBeInTheDocument();
  });

  it("renders a stat row, badge and swatch", () => {
    render(
      <dl>
        <GemStatRow label="Account" value="Broker IRA" />
        <GemBadge tone="gray">winner</GemBadge>
        <GemSwatch colour="var(--chart-5)" />
      </dl>,
    );
    expect(screen.getByText("Account")).toBeInTheDocument();
    expect(screen.getByText("Broker IRA")).toBeInTheDocument();
    expect(screen.getByText("winner")).toBeInTheDocument();
  });

  it("labels the donut and draws one arc per segment", () => {
    render(
      <GemDonut
        segments={[
          { key: "a", percent: 50, colour: "var(--chart-1)" },
          { key: "b", percent: 50, colour: "var(--chart-2)" },
        ]}
        centreValue={2}
        centreLabel="assets"
        ariaLabel="Strategy uses 2 assets"
      />,
    );
    const donut = screen.getByRole("img", { name: "Strategy uses 2 assets" });
    expect(donut).toBeInTheDocument();
    // One track circle plus one arc per segment.
    expect(donut.querySelectorAll("circle")).toHaveLength(3);
    expect(screen.getByText("assets")).toBeInTheDocument();
  });

  it("draws only the track when every segment is empty", () => {
    render(
      <GemDonut
        segments={[{ key: "a", percent: 0, colour: "var(--chart-1)" }]}
        centreValue={0}
        ariaLabel="No allocation"
      />,
    );
    expect(
      screen
        .getByRole("img", { name: "No allocation" })
        .querySelectorAll("circle"),
    ).toHaveLength(1);
  });

  it("renders a neutral comparison bar, and the loss tone when negative", () => {
    const { container, rerender } = render(<GemBar width={40} />);
    const fill = () => container.querySelector<HTMLElement>('[aria-hidden="true"] > div');
    expect(fill()).toHaveStyle({ width: "40%" });
    // Colour is reserved for the chart series and for gains/losses, so a
    // positive bar is neutral rather than tinted per asset -- and it comes
    // from the chart tokens, so it re-colours with the theme instead of
    // staying Tailwind grey/red on every palette.
    // Read from the inline style the component writes: the computed style
    // resolves `var()` against a theme the test document does not load.
    expect(fill()?.style.backgroundColor).toBe("var(--chart-neutral)");
    expect(fill()?.className).not.toMatch(/bg-(gray|red)-\d/);
    rerender(<GemBar width={40} negative />);
    expect(fill()?.style.backgroundColor).toBe("var(--chart-expense)");
  });

  it("renders an empty state with an optional action", () => {
    render(
      <GemEmptyState
        title="No account assigned"
        description="Assign an account"
        action={<button type="button">Assign</button>}
      />,
    );
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
    expect(screen.getByText("Assign an account")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Assign" })).toBeInTheDocument();
  });
});
