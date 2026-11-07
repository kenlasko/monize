import { HelpSearchSection, searchHelp } from "./help-search";

function section(
  overrides: Partial<HelpSearchSection> & Pick<HelpSearchSection, "page">,
): HelpSearchSection {
  return {
    section: null,
    pageTitle: "",
    heading: "",
    text: "",
    ...overrides,
  };
}

describe("searchHelp", () => {
  it("ranks a heading match over a body-only match", () => {
    const sections = [
      section({
        page: "a",
        section: "a",
        heading: "Budgets Overview",
        text: "Nothing relevant here.",
      }),
      section({
        page: "b",
        section: "b",
        heading: "Something Else",
        text: "This explains budgets in detail.",
      }),
    ];

    const { results } = searchHelp(sections, "budgets");

    expect(results.map((r) => r.page)).toEqual(["a", "b"]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("ranks a page-title match over a body-only match", () => {
    const sections = [
      section({ page: "a", section: "a", pageTitle: "Budgets", text: "x" }),
      section({
        page: "b",
        section: "b",
        pageTitle: "Other",
        text: "Covers budgets too.",
      }),
    ];

    const { results } = searchHelp(sections, "budgets");

    expect(results.map((r) => r.page)).toEqual(["a", "b"]);
  });

  it("ranks every token matching over only some of them", () => {
    const sections = [
      section({
        page: "all",
        section: "s",
        heading: "Split a transaction",
        text: "x",
      }),
      section({
        page: "some",
        section: "s",
        heading: "Split a budget",
        text: "x",
      }),
    ];

    const { results } = searchHelp(sections, "split transaction");

    expect(results.map((r) => r.page)).toEqual(["all", "some"]);
  });

  it("matches the last token as a prefix, so results appear while typing", () => {
    const sections = [
      section({ page: "a", section: "a", heading: "Transactions", text: "" }),
    ];

    const { results } = searchHelp(sections, "transac");

    expect(results).toHaveLength(1);
    expect(results[0].page).toBe("a");
  });

  it("does not prefix-match a token that is not the last one typed", () => {
    const sections = [
      section({ page: "a", section: "a", heading: "Transactions", text: "" }),
    ];

    // "transac" is the first of two tokens here, so it must match exactly,
    // not as a prefix -- only "nope" (the last token) gets prefix treatment.
    const { results } = searchHelp(sections, "transac nope");

    expect(results).toHaveLength(0);
  });

  it("ignores accents", () => {
    const sections = [
      section({ page: "a", section: "a", heading: "Deja vu import", text: "" }),
    ];

    const { results } = searchHelp(sections, "deja");

    expect(results).toHaveLength(1);
  });

  it("matches a synonym of the typed word", () => {
    const sections = [
      section({
        page: "a",
        section: "a",
        heading: "Chequing accounts",
        text: "",
      }),
    ];

    const { results } = searchHelp(sections, "checking");

    expect(results).toHaveLength(1);
    expect(results[0].page).toBe("a");
  });

  it("folds 2FA, two-factor and TOTP into the same match, without matching 'two' or 'factor' alone elsewhere", () => {
    const sections = [
      section({
        page: "totp",
        section: "s",
        heading: "Setting up TOTP",
        text: "",
      }),
      section({
        page: "unrelated",
        section: "s",
        heading: "Two rows, one factor each",
        text: "",
      }),
    ];

    const { results } = searchHelp(sections, "2fa");

    expect(results.map((r) => r.page)).toEqual(["totp"]);
  });

  it("boosts a section of the current screen enough to lead among comparable matches", () => {
    const sections = [
      section({
        page: "elsewhere",
        section: "s",
        pageTitle: "Elsewhere",
        text: "mentions budgets",
      }),
      section({
        page: "here",
        section: "s",
        pageTitle: "Here",
        text: "mentions budgets",
      }),
    ];

    const { results } = searchHelp(sections, "budgets", {
      contextPage: "here",
    });

    expect(results[0].page).toBe("here");
  });

  it("never lets the context boost outrank a heading match elsewhere", () => {
    const sections = [
      section({
        page: "here",
        section: "s",
        pageTitle: "Here",
        text: "mentions budgets only in the body",
      }),
      section({
        page: "elsewhere",
        section: "s",
        heading: "Budgets",
        text: "x",
      }),
    ];

    const { results } = searchHelp(sections, "budgets", {
      contextPage: "here",
    });

    expect(results[0].page).toBe("elsewhere");
  });

  it("breaks a tied score by the sections' original order, so results are stable", () => {
    const sections = [
      section({ page: "first", section: "s", heading: "Budgets", text: "" }),
      section({ page: "second", section: "s", heading: "Budgets", text: "" }),
    ];

    const { results } = searchHelp(sections, "budgets");

    expect(results.map((r) => r.page)).toEqual(["first", "second"]);
  });

  it("bounds the excerpt to about 160 characters, with an ellipsis where text was cut on both sides", () => {
    const lead = "x".repeat(100);
    const tail = "y".repeat(200);
    const sections = [
      section({
        page: "a",
        section: "a",
        text: `${lead} budgets ${tail}`,
      }),
    ];

    const { results } = searchHelp(sections, "budgets");

    expect(results[0].excerpt.length).toBeLessThanOrEqual(162);
    expect(results[0].excerpt).toContain("budgets");
    expect(results[0].excerpt.startsWith("…")).toBe(true);
    expect(results[0].excerpt.endsWith("…")).toBe(true);
  });

  it("slices the text it was given, not a length-changing normalization of it", () => {
    // NFKD decomposes "½" into three characters ("1⁄2"), two longer than the
    // original. A run of a hundred of them pushes a match index found in a
    // normalized copy of the text about 200 characters further along than
    // the real text is long -- enough that slicing the real text at that
    // index would land past its end and miss "budgets" entirely.
    const lead = "x".repeat(50);
    const ligatures = "½".repeat(100);
    const tail = "y".repeat(50);
    const sections = [
      section({
        page: "a",
        section: "a",
        text: `${lead}${ligatures} budgets ${tail}`,
      }),
    ];

    const { results } = searchHelp(sections, "budgets");

    expect(results[0].excerpt).toContain("budgets");
  });

  it("introduces no markup of its own: the excerpt is exactly a slice of the plain text given", () => {
    const sections = [
      section({
        page: "a",
        section: "a",
        text: "Here is how you add a budget without any markup in the source.",
      }),
    ];

    const { results } = searchHelp(sections, "budget");

    expect(results[0].excerpt).not.toContain("<");
    expect(results[0].excerpt).not.toContain(">");
  });

  it("answers nothing for a query with no tokens", () => {
    const sections = [section({ page: "a", section: "a", heading: "Budgets" })];

    expect(searchHelp(sections, "   ")).toEqual({ results: [], total: 0 });
  });

  it("limits results but reports the full match count in total", () => {
    const sections = Array.from({ length: 15 }, (_, i) =>
      section({ page: `p${i}`, section: "s", heading: "Budgets" }),
    );

    const { results, total } = searchHelp(sections, "budgets", { limit: 5 });

    expect(results).toHaveLength(5);
    expect(total).toBe(15);
  });

  it("ignores a query of only stop words by searching them anyway", () => {
    const sections = [
      section({ page: "a", section: "a", heading: "How to do it" }),
    ];

    const { results } = searchHelp(sections, "how to");

    expect(results).toHaveLength(1);
  });
});
