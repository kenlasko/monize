import { FetchLike } from "../health";

/**
 * A scripted `fetch`, for specs only. Each URL answers with a status, refuses
 * the connection (what a port with no listener does, and the default), or
 * hangs until its request is aborted.
 */
export type FakeAnswer = number | "refused" | "hang";

export interface FakeFetch {
  readonly fetch: FetchLike;
  /** Every URL requested, in order. */
  readonly calls: readonly string[];
  /** Requests that are open right now. */
  readonly open: number;
  respond(url: string, answer: FakeAnswer): void;
}

function refused(): Error {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
}

export function fakeFetch(): FakeFetch {
  const answers = new Map<string, FakeAnswer>();
  const calls: string[] = [];
  let open = 0;
  return {
    calls,
    get open() {
      return open;
    },
    respond(url, answer) {
      answers.set(url, answer);
    },
    fetch(url, init) {
      calls.push(url);
      const answer = answers.get(url) ?? "refused";
      if (answer === "refused") return Promise.reject(refused());
      if (answer !== "hang") return Promise.resolve({ status: answer });
      open += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener(
          "abort",
          () => {
            open -= 1;
            reject(
              new DOMException("This operation was aborted", "AbortError"),
            );
          },
          { once: true },
        );
      });
    },
  };
}
