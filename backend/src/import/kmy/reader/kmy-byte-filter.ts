/**
 * KMyMoney's `validateUtf8AndXML` (spec 4.4), run once over the whole buffer.
 * States: F = first char, L = a lead byte was just emitted, S = inside a
 * continuation sequence.
 */

const enum State {
  First,
  LeadSeen,
  SequenceSeen,
}

function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

/** Returns a new buffer; `input` is not mutated. */
export function filterKmyBytes(input: Buffer): Buffer {
  const out = Buffer.allocUnsafe(input.length);
  let length = 0;
  let state: State = State.First;

  for (let i = 0; i < input.length; i++) {
    const byte = input[i];
    if (byte < 0x80) {
      if (state === State.LeadSeen) {
        // The lead byte had no continuation: drop it.
        length--;
      }
      if (isPrintableAscii(byte)) {
        out[length++] = byte;
      }
      state = State.First;
    } else if (byte >= 0xc0) {
      if (state === State.LeadSeen) {
        out[length - 1] = byte;
      } else {
        out[length++] = byte;
      }
      state = State.LeadSeen;
    } else if (state === State.First) {
      // A continuation byte with no lead: dropped.
    } else {
      out[length++] = byte;
      state = State.SequenceSeen;
    }
  }
  return Buffer.from(out.subarray(0, length));
}
