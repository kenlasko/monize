import { Parser } from "htmlparser2";
import { KmyCorruptFileError } from "../model/kmy-errors";

/**
 * The only module that imports htmlparser2. Turns a filtered document into
 * open/close events keyed by element path, and enforces what the tokenizer
 * does not: one root named KMYMONEY-FILE, every element closed by its own
 * tag, nesting no deeper than 64 (spec 4.2 and 4.4).
 */

export const KMY_ROOT = "KMYMONEY-FILE";
export const KMY_MAX_DEPTH = 64;
const DECODE_SLICE_BYTES = 64 * 1024;

export type KmyAttributes = Readonly<Record<string, string>>;

export interface KmyXmlEvents {
  /** `path` is the element's own path from the root, "/"-separated. */
  open(path: string, attributes: KmyAttributes): void;
  close(path: string): void;
}

interface OpenElement {
  readonly name: string;
  readonly openEndIndex: number;
}

/**
 * htmlparser2 silently ignores an end tag that matches no open element; a
 * well-formed document has none, so the subclass reports one.
 */
class KmyParser extends Parser {
  closeEvents = 0;
  onStrayClose: () => void = () => undefined;

  override onclosetag(start: number, endIndex: number): void {
    const before = this.closeEvents;
    super.onclosetag(start, endIndex);
    if (this.closeEvents === before) {
      this.onStrayClose();
    }
  }
}

export function tokenizeKmyXml(xml: Buffer, events: KmyXmlEvents): void {
  const stack: OpenElement[] = [];
  const names: string[] = [];
  let rootSeen = false;
  let rootClosed = false;

  const parser: KmyParser = new KmyParser(
    {
      onopentag(name, attributes) {
        if (stack.length === 0) {
          if (rootClosed) {
            throw new KmyCorruptFileError("content follows the root element");
          }
          if (name !== KMY_ROOT) {
            throw new KmyCorruptFileError(`the root element is ${name}`);
          }
          rootSeen = true;
        }
        if (stack.length >= KMY_MAX_DEPTH) {
          throw new KmyCorruptFileError("elements are nested too deeply");
        }
        stack.push({ name, openEndIndex: parser.endIndex });
        names.push(name);
        events.open(names.join("/"), attributes);
      },
      onclosetag(name, isImplied) {
        parser.closeEvents++;
        const top = stack[stack.length - 1];
        if (!top || top.name !== name) {
          throw new KmyCorruptFileError(`a close tag ${name} does not match`);
        }
        // An implied close whose position differs from the open tag's end is a
        // tag that was never closed; a self-closing tag closes where it opens.
        if (isImplied && parser.endIndex !== top.openEndIndex) {
          throw new KmyCorruptFileError(`element ${name} is not closed`);
        }
        events.close(names.join("/"));
        stack.pop();
        names.pop();
        if (stack.length === 0) {
          rootClosed = true;
        }
      },
      onerror(error) {
        throw new KmyCorruptFileError("the XML cannot be tokenized", error);
      },
    },
    { xmlMode: true, decodeEntities: true, recognizeSelfClosing: true },
  );

  parser.onStrayClose = () => {
    throw new KmyCorruptFileError("a close tag matches no open element");
  };

  const decoder = new TextDecoder("utf-8", { fatal: false });
  for (let offset = 0; offset < xml.length; offset += DECODE_SLICE_BYTES) {
    const slice = xml.subarray(offset, offset + DECODE_SLICE_BYTES);
    parser.write(decoder.decode(slice, { stream: true }));
  }
  const tail = decoder.decode();
  if (tail) {
    parser.write(tail);
  }
  parser.end();

  if (!rootSeen) {
    throw new KmyCorruptFileError("there is no root element");
  }
  if (stack.length > 0) {
    throw new KmyCorruptFileError("the document ends inside an element");
  }
}
