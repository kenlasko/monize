import Link from "next/link";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test/render";
import { SharedNavigationGuard } from "./SharedNavigationGuard";

describe("Unsaved private draft navigation", () => {
  it("warns on refresh while pending, and releases the guard once uploaded", () => {
    const view = render(
      <SharedNavigationGuard when message="Files are not uploaded" />,
    );
    const pending = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(pending);
    expect(pending.defaultPrevented).toBe(true);
    view.rerender(
      <SharedNavigationGuard when={false} message="Files are not uploaded" />,
    );
    const saved = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(saved);
    expect(saved.defaultPrevented).toBe(false);
  });
  it("cancels a route change without losing the current file selection", () => {
    const navigate = vi.fn();
    render(
      <>
        <SharedNavigationGuard when message="Files are not uploaded" />
        <Link href="/accounts" onClick={navigate}>
          Accounts
        </Link>
      </>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Accounts" }));
    expect(screen.getByText("Files are not uploaded")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep Editing" }));
    expect(
      screen.queryByText("Files are not uploaded"),
    ).not.toBeInTheDocument();
  });
});
