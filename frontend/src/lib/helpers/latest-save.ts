/**
 * Orders the replies of saves a reader fires in quick succession (arrowing
 * through a radio group saves each option), so the store ends on what the
 * server holds.
 *
 * The latest save's reply is adopted and reported. An earlier save's reply is
 * held back while the latest is still in flight, so it cannot put the store
 * back on a choice the reader has moved past; but once the latest has failed,
 * the newest earlier success is adopted, because that is the write the server
 * kept. Dropping it left the store on neither choice while the server held
 * one of them.
 */
export interface SaveOutcome<T> {
  /** The reply to put in the store, or `null` for none. */
  adopt: T | null;
  /** Whether this was the latest save, the one whose outcome is reported. */
  isLatest: boolean;
}

export interface SaveTicket<T> {
  succeeded(reply: T): SaveOutcome<T>;
  failed(): SaveOutcome<T>;
}

export interface LatestSaveTracker<T> {
  begin(): SaveTicket<T>;
}

export function createLatestSaveTracker<T>(): LatestSaveTracker<T> {
  let latest = 0;
  let adopted = 0;
  let latestFailed = false;
  let held: { seq: number; reply: T } | null = null;

  const adoptHeld = (): T | null => {
    if (!held || held.seq <= adopted) return null;
    adopted = held.seq;
    const { reply } = held;
    held = null;
    return reply;
  };

  return {
    begin() {
      const seq = ++latest;
      latestFailed = false;
      return {
        succeeded(reply) {
          if (seq <= adopted) return { adopt: null, isLatest: false };
          if (seq === latest) {
            adopted = seq;
            held = null;
            return { adopt: reply, isLatest: true };
          }
          if (latestFailed) {
            adopted = seq;
            return { adopt: reply, isLatest: false };
          }
          if (!held || seq > held.seq) held = { seq, reply };
          return { adopt: null, isLatest: false };
        },
        failed() {
          if (seq !== latest) return { adopt: null, isLatest: false };
          latestFailed = true;
          return { adopt: adoptHeld(), isLatest: true };
        },
      };
    },
  };
}
