import {
  detectCsvDateFormat,
  parseCsv,
  parseCsvHeaders,
  CsvColumnMappingConfig,
} from "./csv-parser";

function config(dateFormat: string): CsvColumnMappingConfig {
  return {
    date: 0,
    amount: 1,
    payee: 2,
    dateFormat,
    hasHeader: true,
    delimiter: ",",
  };
}

function datesOf(csvDates: string[], dateFormat: string): (string | null)[] {
  const csv = [
    "Date,Amount,Payee",
    ...csvDates.map((d, i) => `"${d}",-${i + 1}.00,Shop ${i}`),
  ].join("\n");
  const result = parseCsv(csv, config(dateFormat));
  return csvDates.map((_, i) => {
    const tx = result.transactions.find((t) => t.payee === `Shop ${i}`);
    return tx ? tx.date : null;
  });
}

describe("CSV date format detection", () => {
  it("reads every row, so a day-first file whose first rows fall on the 1st to the 12th is DD/MM/YYYY", () => {
    // The five-row guess read this as MM/DD/YYYY and the rows after the
    // 12th became unreadable.
    const dates = [
      "01/03/2026",
      "02/03/2026",
      "05/03/2026",
      "08/03/2026",
      "11/03/2026",
      "12/03/2026",
      "20/03/2026",
    ];
    expect(detectCsvDateFormat(dates)).toBe("DD/MM/YYYY");
  });

  it("finds a month-first row after the fifth", () => {
    const dates = [
      "01/02/2026",
      "02/02/2026",
      "03/02/2026",
      "04/02/2026",
      "05/02/2026",
      "02/25/2026",
    ];
    expect(detectCsvDateFormat(dates)).toBe("MM/DD/YYYY");
  });

  it("reads a file whose every day is the 12th or earlier month first", () => {
    expect(detectCsvDateFormat(["01/02/2026", "03/04/2026"])).toBe(
      "MM/DD/YYYY",
    );
  });

  it("chooses the format that reads the most rows when the file disagrees with itself", () => {
    expect(
      detectCsvDateFormat(["13/01/2026", "14/01/2026", "01/13/2026"]),
    ).toBe("DD/MM/YYYY");
  });

  it("tells YYYY-MM-DD from YYYY-DD-MM", () => {
    expect(detectCsvDateFormat(["2026-01-05", "2026-01-15"])).toBe(
      "YYYY-MM-DD",
    );
    expect(detectCsvDateFormat(["2026-05-01", "2026-15-01"])).toBe(
      "YYYY-DD-MM",
    );
    expect(detectCsvDateFormat(["2026-01-15T12:00:00Z"])).toBe("YYYY-MM-DD");
    expect(detectCsvDateFormat(["01/15/2026 14:30"])).toBe("MM/DD/YYYY");
  });

  it("detects month-name dates", () => {
    expect(detectCsvDateFormat(["15-Jan-2026", "03-FEB-2026"])).toBe(
      "DD-MMM-YYYY",
    );
    expect(detectCsvDateFormat(["Jan 15, 2026", "February 3, 2026"])).toBe(
      "MMM DD, YYYY",
    );
  });

  it("is null for a column with no dates", () => {
    expect(detectCsvDateFormat([])).toBeNull();
    expect(detectCsvDateFormat(["", "Grocery", "Q1 2026"])).toBeNull();
    expect(detectCsvDateFormat(["-50.00", "12.5"])).toBeNull();
  });

  it("gives up on a column none of whose first 50 values is a date, but not on a date column with unreadable rows", () => {
    const amounts = Array.from({ length: 60 }, (_, i) => `-${i}.00`);
    expect(detectCsvDateFormat([...amounts, "15/01/2026"])).toBeNull();

    const mostlyUnreadable = [
      "01/15/2026",
      ...Array.from({ length: 60 }, () => "n/a 1"),
    ];
    expect(detectCsvDateFormat(mostlyUnreadable)).toBe("MM/DD/YYYY");
  });

  it("parseCsvHeaders returns a format for each column, from the whole file", () => {
    const lines = ["Posted,Amount,Payee,Value Date"];
    for (let day = 1; day <= 12; day++) {
      const dd = String(day).padStart(2, "0");
      lines.push(`${dd}/03/2026,-${day}.00,Shop,2026-03-${dd}`);
    }
    lines.push("25/03/2026,-25.00,Shop,2026-03-25");

    const result = parseCsvHeaders(lines.join("\n"), ",");

    expect(result.sampleRows).toHaveLength(5);
    expect(result.columnDateFormats).toEqual([
      "DD/MM/YYYY",
      null,
      null,
      "YYYY-MM-DD",
    ]);
  });

  it("parseCsvHeaders returns no formats for an empty file", () => {
    expect(parseCsvHeaders("").columnDateFormats).toEqual([]);
  });
});

describe("CSV month-name dates", () => {
  it("reads DD-MMM-YYYY with any separator, case and abbreviation", () => {
    expect(
      datesOf(
        [
          "15-Jan-2026",
          "15 JAN 2026",
          "15.Sept.2026",
          "5/oct/26",
          "15Jan2026",
          "15-OCTOBER-2026",
        ],
        "DD-MMM-YYYY",
      ),
    ).toEqual([
      "2026-01-15",
      "2026-01-15",
      "2026-09-15",
      "2026-10-05",
      "2026-01-15",
      "2026-10-15",
    ]);
  });

  it("reads MMM DD, YYYY with or without the comma, and with a time", () => {
    expect(
      datesOf(
        [
          "Jan 15, 2026",
          "January 15 2026",
          "Aug-03-2026",
          "Dec 31, 2026 2:30 PM",
        ],
        "MMM DD, YYYY",
      ),
    ).toEqual(["2026-01-15", "2026-01-15", "2026-08-03", "2026-12-31"]);
  });

  it("reads the month names of the app's languages", () => {
    expect(
      datesOf(
        [
          "15 janv. 2026",
          "15 févr. 2026",
          "15.Mär.2026",
          "15 März 2026",
          "15-ago-2026",
          "15 dic 2026",
          "15 mrt 2026",
          "15 października 2026",
          "15 Ara 2026",
        ],
        "DD-MMM-YYYY",
      ),
    ).toEqual([
      "2026-01-15",
      "2026-02-15",
      "2026-03-15",
      "2026-03-15",
      "2026-08-15",
      "2026-12-15",
      "2026-03-15",
      "2026-10-15",
      "2026-12-15",
    ]);
  });

  it("reads an upper-case Turkish month, whose I lower-cases dotted", () => {
    expect(
      datesOf(
        ["15 KASIM 2026", "15 MAYIS 2026", "15 Kasım 2026", "15 EKİM 2026"],
        "DD-MMM-YYYY",
      ),
    ).toEqual(["2026-11-15", "2026-05-15", "2026-11-15", "2026-10-15"]);
  });

  it("reports a name that is no month, an ambiguous one and a day the month does not have as unreadable", () => {
    const csv = [
      "Date,Amount,Payee",
      "15-Foo-2026,-1.00,A",
      // French "jui" begins both juin and juillet.
      "15-jui-2026,-2.00,B",
      "30-Feb-2026,-3.00,C",
      "15-Jan-2026,-4.00,D",
    ].join("\n");

    const result = parseCsv(csv, config("DD-MMM-YYYY"));

    expect(result.transactions.map((t) => t.payee)).toEqual(["D"]);
    expect(result.unreadableDateRows?.map((r) => r.rawDate)).toEqual([
      "15-Foo-2026",
      "15-jui-2026",
      "30-Feb-2026",
    ]);
  });

  it("reads MMM and MMMM in a custom pattern", () => {
    expect(datesOf(["2026/Jan/15"], "YYYY/MMM/DD")).toEqual(["2026-01-15"]);
    expect(datesOf(["15 January 2026"], "DD MMMM YYYY")).toEqual([
      "2026-01-15",
    ]);
    expect(datesOf(["15.Mär.2026", "15.janv..2026"], "DD.MMM.YYYY")).toEqual([
      "2026-03-15",
      "2026-01-15",
    ]);
    expect(datesOf(["15-Foo-2026"], "DD-MMM-YY")).toEqual([null]);
  });

  it("keeps the T of an upper-case month name, which is not an ISO time", () => {
    expect(datesOf(["15-OCT-2026", "AUGUST 3, 2026"], "DD-MMM-YYYY")).toEqual([
      "2026-10-15",
      null,
    ]);
    expect(datesOf(["AUGUST 3, 2026"], "MMM DD, YYYY")).toEqual(["2026-08-03"]);
  });
});
