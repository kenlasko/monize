import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@/test/render";
import { SharedMoneyInput } from "./SharedPrimitives";

function ControlledMoney({
  places,
  initial = "",
  onChange,
}: {
  places: number;
  initial?: string;
  onChange: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <SharedMoneyInput
      label="Amount"
      currency={places === 0 ? "JPY" : places === 3 ? "KWD" : "USD"}
      places={places}
      value={value}
      onChange={(next) => {
        onChange(next);
        setValue(next);
      }}
    />
  );
}

describe("SharedMoneyInput uses CurrencyInput throughout currency entry", () => {
  const cases = [
    [0, "100/3", "33", "33"],
    [2, "100/3", "33.33", "33.33"],
    [3, "100/3", "33.333", "33.333"],
    [4, "100/3", "33.3333", "33.3333"],
  ] as const;

  describe.each(["blur", "Enter", "calculator"] as const)("%s", (commit) => {
    it.each(cases)(
      "submits the same %i-decimal amount the calculator displays",
      (places, expression, expected, display) => {
        const onChange = vi.fn();
        render(<ControlledMoney places={places} onChange={onChange} />);
        const input = screen.getByRole("textbox", { name: "Amount" });
        if (commit === "calculator") {
          fireEvent.click(
            screen.getByRole("button", { name: "Open calculator" }),
          );
          const calculator = screen.getByRole("dialog", { name: "Calculator" });
          fireEvent.change(within(calculator).getByRole("textbox"), {
            target: { value: expression },
          });
          expect(within(calculator).getByText(display)).toBeInTheDocument();
          fireEvent.click(
            within(calculator).getByRole("button", { name: "Apply" }),
          );
        } else {
          fireEvent.focus(input);
          fireEvent.change(input, { target: { value: expression } });
          if (commit === "Enter") fireEvent.keyDown(input, { key: "Enter" });
          fireEvent.blur(input);
        }
        expect(onChange).toHaveBeenLastCalledWith(expected);
        expect(input).toHaveValue(display);
      },
    );
  });

  it.each([3, 4])(
    "clears a formatted zero on focus at %i decimals",
    (places) => {
      const onChange = vi.fn();
      render(
        <ControlledMoney places={places} initial="0" onChange={onChange} />,
      );
      const input = screen.getByRole("textbox", { name: "Amount" });
      fireEvent.focus(input);
      expect(input).toHaveValue("");
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("keeps a stored bank amount when its four-decimal calculator is opened and applied", () => {
    const onChange = vi.fn();
    render(<ControlledMoney places={4} initial="1.2345" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Open calculator" }));
    const calculator = screen.getByRole("dialog", { name: "Calculator" });
    expect(within(calculator).getByRole("textbox")).toHaveValue("1.2345");
    fireEvent.click(within(calculator).getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("textbox", { name: "Amount" })).toHaveValue(
      "1.2345",
    );
    expect(onChange.mock.calls.every(([value]) => value === "1.2345")).toBe(
      true,
    );
  });
});
