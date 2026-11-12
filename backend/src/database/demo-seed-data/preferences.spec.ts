import { readFileSync } from "fs";
import { join } from "path";
import { dashboardWidgetConfig, dashboardWidgets } from "./preferences";

const frontend = join(
  __dirname,
  "../../../../frontend/src/components/dashboard",
);
const registry = readFileSync(join(frontend, "widget-registry.tsx"), "utf8");
const layout = readFileSync(join(frontend, "dashboard-layout.ts"), "utf8");

const SPANS: Record<string, number> = {
  third: 4,
  half: 6,
  twoThirds: 8,
  full: 12,
};

/** The presets the dashboard accepts, read from its own source. */
function presets(name: string): string[] {
  const body = new RegExp(`${name} = \\[([^\\]]+)\\]`).exec(layout)![1];
  return [...body.matchAll(/'(\w+)'/g)].map((m) => m[1]);
}

describe("demo dashboard layout", () => {
  const known = new Set(
    [...registry.matchAll(/^\s+id: '([a-z-]+)',/gm)].map((m) => m[1]),
  );

  it("uses only widgets the dashboard has", () => {
    for (const id of dashboardWidgets) expect(known).toContain(id);
  });

  it("sizes every widget with presets the dashboard accepts", () => {
    const widths = presets("WIDGET_WIDTHS");
    const heights = presets("WIDGET_HEIGHTS");
    expect([...dashboardWidgets].sort()).toEqual(
      Object.keys(dashboardWidgetConfig).sort(),
    );
    for (const id of dashboardWidgets) {
      expect(widths).toContain(dashboardWidgetConfig[id].gridWidth);
      expect(heights).toContain(dashboardWidgetConfig[id].gridHeight);
    }
  });

  it("flows into complete 12-column rows of mixed widths and heights", () => {
    let used = 0;
    for (const id of dashboardWidgets) {
      used += SPANS[dashboardWidgetConfig[id].gridWidth];
      expect(used).toBeLessThanOrEqual(12);
      if (used === 12) used = 0;
    }
    expect(used).toBe(0);
    const widths = new Set(
      dashboardWidgets.map((id) => dashboardWidgetConfig[id].gridWidth),
    );
    const heights = new Set(
      dashboardWidgets.map((id) => dashboardWidgetConfig[id].gridHeight),
    );
    expect(widths.size).toBeGreaterThanOrEqual(3);
    expect(heights.size).toBeGreaterThanOrEqual(3);
  });

  it("includes the warranties widget", () => {
    expect(dashboardWidgets).toContain("warranties-expiring");
  });

  it("is a widget count and shape the settings validator accepts", () => {
    expect(dashboardWidgets.length).toBeLessThanOrEqual(50);
    for (const slice of Object.values(dashboardWidgetConfig)) {
      expect(Object.keys(slice).length).toBeLessThanOrEqual(20);
    }
  });
});
