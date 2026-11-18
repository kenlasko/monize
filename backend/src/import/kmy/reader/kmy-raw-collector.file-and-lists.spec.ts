import {
  kmyElement,
  kmyFile,
  kmyInstitution,
  kmyPayee,
  kmyTag,
} from "../__fixtures__/kmy-xml-builders";
import { readKmyBool, readKmyDate, readKmyUint } from "./kmy-reader-values";
import { collect } from "./kmy-raw-collector.test-helpers";

describe("attribute decoding", () => {
  it("accepts real calendar dates only", () => {
    expect(readKmyDate("2024-02-29")).toBe("2024-02-29");
    expect(readKmyDate("2023-02-29")).toBeNull();
    expect(readKmyDate("2024-13-01")).toBeNull();
    expect(readKmyDate("2024-1-1")).toBeNull();
    expect(readKmyDate("2024-05-01T12:00:00")).toBeNull();
    expect(readKmyDate("")).toBeNull();
    expect(readKmyDate(undefined)).toBeNull();
  });

  it("reads booleans case-insensitively with a default", () => {
    for (const yes of ["1", "on", "TRUE", "Yes"]) {
      expect(readKmyBool(yes, false)).toBe(true);
    }
    for (const no of ["0", "off", "False", "NO"]) {
      expect(readKmyBool(no, true)).toBe(false);
    }
    expect(readKmyBool("maybe", true)).toBe(true);
    expect(readKmyBool(undefined, false)).toBe(false);
  });

  it("reads unsigned integers with a fallback", () => {
    expect(readKmyUint("12", 0)).toBe(12);
    expect(readKmyUint("-1", 7)).toBe(7);
    expect(readKmyUint("x", 7)).toBe(7);
    expect(readKmyUint(undefined, 7)).toBe(7);
  });
});

describe("KmyRawCollector", () => {
  describe("FILEINFO and file-level KVP", () => {
    it("reads the current form", () => {
      const file = collect(kmyFile());
      expect(file.fileInfo).toEqual({
        container: "xml",
        fixVersion: 12,
        appVersion: "synthetic",
        creationDate: "2024-01-01",
        lastModified: "2024-05-01T12:00:00+00:00",
      });
      expect(file.baseCurrency).toBe("USD");
    });

    it.each([
      ['<FIXVERSION id="12"/>', 12],
      ['<FIXVERSION date="4"/>', 4],
      ['<FIXVERSION date="" id="9"/>', 9],
      ['<FIXVERSION date=""/>', 5],
      ['<FIXVERSION id=""/>', 5],
      ["<FIXVERSION/>", 5],
      ['<FIXVERSION date="2"/>', 3],
      ['<FIXVERSION id="2"/>', 3],
      ["", 12],
    ])("fix version of %s is %d", (element, expected) => {
      const info = `<FILEINFO><CREATION_DATE date=""/>${element}</FILEINFO>`;
      const file = collect(kmyFile({ fileInfo: info }));
      expect(file.fileInfo.fixVersion).toBe(expected);
      expect(file.fileInfo.creationDate).toBeNull();
      expect(file.fileInfo.appVersion).toBeNull();
      expect(file.fileInfo.lastModified).toBeNull();
    });

    it("reads a date-only LAST_MODIFIED_DATE as written", () => {
      const info =
        '<FILEINFO><LAST_MODIFIED_DATE date="2017-10-20"/></FILEINFO>';
      expect(collect(kmyFile({ fileInfo: info })).fileInfo.lastModified).toBe(
        "2017-10-20",
      );
    });

    it("has no base currency when the pair is missing or empty", () => {
      expect(
        collect(kmyFile({ kvp: { "kmm-baseCurrency": "" } })).baseCurrency,
      ).toBeNull();
    });
  });

  describe("institutions, payees, tags, cost centers", () => {
    it("reads institutions with their account ids", () => {
      const file = collect(
        kmyFile({
          institutions: [kmyInstitution({}, ["A000001", "A000009"])],
        }),
      );
      expect(file.institutions).toEqual([
        {
          ordinal: 1,
          id: "I000001",
          name: "Example Bank",
          accountIds: ["A000001", "A000009"],
        },
      ]);
    });

    describe("payees (reference 10.1)", () => {
      const only = (
        overrides: Record<string, string | number>,
        children?: string,
      ) =>
        collect(
          kmyFile({ payees: [kmyPayee({ id: "P1", ...overrides }, children)] }),
        ).payees[0];

      it("reads a plain payee with matching disabled and no details", () => {
        expect(only({ name: "plain" })).toEqual({
          ordinal: 1,
          id: "P1",
          name: "plain",
          match: { kind: "disabled", ignoreCase: false, keys: [] },
          defaultAccountId: null,
          notes: "",
          email: "",
          reference: "",
          address: {
            street: "",
            city: "",
            state: "",
            postcode: "",
            telephone: "",
          },
          hasIdentifiers: false,
          hasLinkPattern: false,
        });
      });

      it("reads the four matching modes", () => {
        expect(only({ matchingenabled: 1, usingmatchkey: 0 }).match.kind).toBe(
          "name",
        );
        expect(
          only({ matchingenabled: 1, usingmatchkey: 0, matchkey: "^$" }).match
            .kind,
        ).toBe("nameExact");
        expect(
          only({ matchingenabled: 1, usingmatchkey: 1, matchkey: "A\n" }).match
            .kind,
        ).toBe("key");
        expect(only({ matchingenabled: 0, usingmatchkey: 1 }).match.kind).toBe(
          "disabled",
        );
      });

      it("reads matching flags as unsigned integers: empty and text are 0, any other number true", () => {
        expect(only({ matchingenabled: "true" }).match.kind).toBe("disabled");
        expect(only({ matchingenabled: "" }).match.kind).toBe("disabled");
        expect(only({ matchingenabled: 2, usingmatchkey: 0 }).match.kind).toBe(
          "name",
        );
        expect(
          only({ matchingenabled: 1, usingmatchkey: "true" }).match.kind,
        ).toBe("name");
        expect(only({ matchingenabled: 1, matchignorecase: 7 }).match).toEqual({
          kind: "name",
          ignoreCase: true,
          keys: [],
        });
        expect(only({ matchingenabled: 1 }).match.ignoreCase).toBe(false);
      });

      it("splits keys on a line feed, drops the trailing empty one and keeps spaces inside keys", () => {
        const match = only({
          matchingenabled: 1,
          usingmatchkey: 1,
          matchkey: " A B \n\n   \nC;D\n",
        }).match;
        expect(match.keys).toEqual([" A B ", "C;D"]);
      });

      it("splits keys on ; only when the value holds no line feed (KMyMoney 4.8)", () => {
        expect(
          only({ matchingenabled: 1, usingmatchkey: 1, matchkey: "A;;  ;B" })
            .match.keys,
        ).toEqual(["A", "B"]);
      });

      it("reads a single key with its trailing line feed from the XML escape", () => {
        const file = collect(
          kmyFile({
            payees: [
              `<PAYEE id="P1" name="x" matchingenabled="1" usingmatchkey="1" matchkey="CITY POWER&#10;"/>`,
            ],
          }),
        );
        expect(file.payees[0].match.keys).toEqual(["CITY POWER"]);
      });

      it("reads the default account, notes, email and reference", () => {
        expect(
          only({
            defaultaccountid: "A000002",
            notes: " n ",
            email: "a@example.invalid",
            reference: "R",
          }),
        ).toMatchObject({
          defaultAccountId: "A000002",
          notes: " n ",
          email: "a@example.invalid",
          reference: "R",
        });
      });

      it("reads the address with the current names, untrimmed", () => {
        const { address } = only(
          {},
          kmyElement("ADDRESS", {
            street: "1 Main St\nSuite 2",
            city: " Springfield ",
            state: "IL",
            zip: "62701",
            telephone: "555 0100",
          }),
        );
        expect(address).toEqual({
          street: "1 Main St\nSuite 2",
          city: " Springfield ",
          state: "IL",
          postcode: "62701",
          telephone: "555 0100",
        });
      });

      it("falls back to the legacy address names (R2.4), taking the first non-empty", () => {
        expect(
          only(
            {},
            kmyElement("ADDRESS", {
              state: "",
              country: "",
              county: "Kent",
              zip: "",
              zipcode: "",
              postcode: "CT1",
            }),
          ).address,
        ).toMatchObject({ state: "Kent", postcode: "CT1" });
        expect(
          only(
            {},
            kmyElement("ADDRESS", {
              state: "",
              country: "UK",
              county: "Kent",
              zip: "Z1",
              zipcode: "Z2",
            }),
          ).address,
        ).toMatchObject({ state: "UK", postcode: "Z1" });
      });

      it("notes a payeeIdentifier child and a non-empty idpattern or urltemplate", () => {
        expect(
          only({}, kmyElement("payeeIdentifier", { id: "1" })).hasIdentifiers,
        ).toBe(true);
        expect(only({ idpattern: "\\d+" }).hasLinkPattern).toBe(true);
        expect(only({ urltemplate: "http://x/%1" }).hasLinkPattern).toBe(true);
        expect(only({ idpattern: "", urltemplate: "" }).hasLinkPattern).toBe(
          false,
        );
      });
    });

    it("reads tags and cost centers", () => {
      const file = collect(
        kmyFile({
          tags: [kmyTag(), kmyTag({ id: "G2", name: "old", closed: 1 })],
          costCenters: [kmyElement("COSTCENTER", { id: "C1", name: "Ops" })],
        }),
      );
      expect(file.tags).toEqual([
        { ordinal: 1, id: "G000001", name: "household", closed: false },
        { ordinal: 2, id: "G2", name: "old", closed: true },
      ]);
      expect(file.costCenters).toEqual([{ ordinal: 1, id: "C1", name: "Ops" }]);
    });

    it("counts ordinals before dropping an element without an id", () => {
      const file = collect(
        kmyFile({ payees: [kmyPayee({ id: "" }), kmyPayee({ id: "P2" })] }),
      );
      expect(file.payees.map((p) => [p.ordinal, p.id])).toEqual([[2, "P2"]]);
    });
  });
});
