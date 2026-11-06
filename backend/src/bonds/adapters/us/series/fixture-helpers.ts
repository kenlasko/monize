import { readFileSync } from "fs";
import { join } from "path";
import { BondFetch } from "../../../bond-adapter";
import { auctionSearchUrl, resultsXmlUrl } from "./series-source";

const FIXTURES = join(__dirname, "fixtures");

/** A saved fixture, as text. */
export function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

/** The `TA_WS` records of a saved fixture. */
export function fixtureJson(name: string): Record<string, unknown>[] {
  return JSON.parse(fixtureText(name));
}

export type Answer =
  | string
  | Uint8Array
  | { status: number; body?: string | Uint8Array; url?: string };

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

/**
 * A `BondFetch` over saved answers by URL: an unlisted URL answers 404. `calls`
 * lists every URL asked, in order, so a test can say what was (not) requested.
 */
export function fakeFetch(
  answers: Readonly<Record<string, Answer>>,
): BondFetch & { readonly calls: string[] } {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    const answer = answers[url];
    if (answer === undefined) return { status: 404, body: new Uint8Array() };
    if (typeof answer === "string" || answer instanceof Uint8Array) {
      return { status: 200, body: bytes(answer), url };
    }
    return {
      status: answer.status,
      body: bytes(answer.body ?? ""),
      url: answer.url ?? url,
    };
  };
  return Object.assign(fetch, { calls });
}

/** The answers of one saved security: its JSON and, when it names one, its results file. */
export function treasuryAnswers(
  cusip: string,
  records: unknown,
  xml: Readonly<Record<string, string>> = {},
): Record<string, Answer> {
  return {
    [auctionSearchUrl(cusip)]: JSON.stringify(records),
    ...Object.fromEntries(
      Object.entries(xml).map(([name, text]) => [resultsXmlUrl(name), text]),
    ),
  };
}
