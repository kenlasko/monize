/**
 * KMyMoney's `validateUtf8AndXML` (spec 4.4), as a stream filter: the same
 * result as one pass over the whole document, chunk boundaries included.
 * States: F = first char, L = a lead byte was just seen, S = inside a
 * continuation sequence. A lead byte is held back until the byte after it
 * decides whether it is dropped (an ASCII or control byte follows), replaced
 * (another lead follows) or emitted (a continuation follows); at the end of
 * the document a held lead is emitted, as the whole-buffer pass leaves it.
 */

const enum State {
  First,
  LeadSeen,
  SequenceSeen,
}

function isPrintableAscii(byte: number): boolean {
  return byte >= 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

export class KmyByteFilter {
  private state: State = State.First;
  /** The lead byte of state L, not yet emitted. */
  private lead = 0;

  /** The filtered bytes of `input` (a new buffer); `input` is not mutated. */
  push(input: Buffer): Buffer {
    const out = Buffer.allocUnsafe(input.length + 1);
    let length = 0;
    for (let i = 0; i < input.length; i++) {
      const byte = input[i];
      if (byte < 0x80) {
        // In state L the held lead had no continuation: dropped.
        if (isPrintableAscii(byte)) {
          out[length++] = byte;
        }
        this.state = State.First;
      } else if (byte >= 0xc0) {
        // A lead replaces a held one; either way it is held.
        this.lead = byte;
        this.state = State.LeadSeen;
      } else if (this.state === State.First) {
        // A continuation byte with no lead: dropped.
      } else {
        if (this.state === State.LeadSeen) {
          out[length++] = this.lead;
        }
        out[length++] = byte;
        this.state = State.SequenceSeen;
      }
    }
    return out.subarray(0, length);
  }

  /** What is still held at the end of the document. */
  flush(): Buffer {
    const held =
      this.state === State.LeadSeen
        ? Buffer.from([this.lead])
        : Buffer.alloc(0);
    this.state = State.First;
    return held;
  }
}

/** The whole-document form: one buffer in, the filtered copy out. */
export function filterKmyBytes(input: Buffer): Buffer {
  const filter = new KmyByteFilter();
  return Buffer.concat([filter.push(input), filter.flush()]);
}
