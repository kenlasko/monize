import { Parser } from "htmlparser2";
import {
  KmyCorruptFileError,
  KmyTooManyRecordsError,
} from "../model/kmy-errors";
import { KMY_MAX_ATTRIBUTE_CHARS, KMY_MAX_ELEMENTS } from "./kmy-limits";

/**
 * The only module that imports htmlparser2. Turns a filtered document, fed in
 * pieces, into open/close events keyed by element path, and enforces what the
 * tokenizer does not: one root named KMYMONEY-FILE, every element closed by
 * its own tag, nesting no deeper than 64 (spec 4.2 and 4.4), each attribute
 * once (QXmlStreamReader refuses a repeated one), no character reference to a
 * character XML 1.0 forbids, and the element and attribute-size bounds of
 * `kmy-limits.ts`, each checked as the document arrives.
 */

export const KMY_ROOT = "KMYMONEY-FILE";
export const KMY_MAX_DEPTH = 64;
const DECODE_SLICE_BYTES = 64 * 1024;

/**
 * True when `value` holds a character XML 1.0's `Char` excludes (C0 controls
 * other than TAB, LF and CR, and U+FFFE / U+FFFF). The byte filter already
 * removed them as raw bytes, so one here came from a character reference
 * such as `&#1;`, which QXmlStreamReader refuses.
 */
function hasForbiddenChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (
      (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
      code === 0xfffe ||
      code === 0xffff
    ) {
      return true;
    }
  }
  return false;
}

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
 * well-formed document has none, so the subclass reports one. It also counts
 * an attribute value's characters as they arrive, so a value past the bound
 * is refused before the rest of it is read.
 */
class KmyParser extends Parser {
  closeEvents = 0;
  attributeChars = 0;
  onStrayClose: () => void = () => undefined;

  override onclosetag(start: number, endIndex: number): void {
    const before = this.closeEvents;
    super.onclosetag(start, endIndex);
    if (this.closeEvents === before) {
      this.onStrayClose();
    }
  }

  override onattribdata(start: number, endIndex: number): void {
    this.attributeChars += endIndex - start;
    if (this.attributeChars > KMY_MAX_ATTRIBUTE_CHARS) {
      throw new KmyTooManyRecordsError("an attribute value is too long");
    }
    super.onattribdata(start, endIndex);
  }
}

export class KmyXmlTokenizer {
  private readonly stack: OpenElement[] = [];
  private readonly names: string[] = [];
  /** The attribute names of the element being opened (a few: a list beats a set). */
  private readonly seenAttributes: string[] = [];
  private readonly parser: KmyParser;
  private rootSeen = false;
  private rootClosed = false;
  private elements = 0;

  constructor(private readonly events: KmyXmlEvents) {
    const stack = this.stack;
    const names = this.names;
    const seen = this.seenAttributes;
    const parser: KmyParser = new KmyParser(
      {
        onopentagname: () => {
          seen.length = 0;
          parser.attributeChars = 0;
        },
        onattribute: (name, value) => {
          parser.attributeChars = 0;
          if (seen.includes(name)) {
            throw new KmyCorruptFileError(`attribute ${name} is repeated`);
          }
          seen.push(name);
          if (hasForbiddenChar(value)) {
            throw new KmyCorruptFileError(
              "a character reference names a character XML does not allow",
            );
          }
        },
        onopentag: (name, attributes) => {
          if (stack.length === 0) {
            if (this.rootClosed) {
              throw new KmyCorruptFileError("content follows the root element");
            }
            if (name !== KMY_ROOT) {
              throw new KmyCorruptFileError(`the root element is ${name}`);
            }
            this.rootSeen = true;
          }
          if (stack.length >= KMY_MAX_DEPTH) {
            throw new KmyCorruptFileError("elements are nested too deeply");
          }
          if (++this.elements > KMY_MAX_ELEMENTS) {
            throw new KmyTooManyRecordsError("the file has too many elements");
          }
          stack.push({ name, openEndIndex: parser.endIndex });
          names.push(name);
          this.events.open(names.join("/"), attributes);
        },
        onclosetag: (name, isImplied) => {
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
          this.events.close(names.join("/"));
          stack.pop();
          names.pop();
          if (stack.length === 0) {
            this.rootClosed = true;
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
    this.parser = parser;
  }

  /** The next piece of the document, as text. */
  write(text: string): void {
    if (text) {
      this.parser.write(text);
    }
  }

  /** The end of the document: anything left open is refused. */
  end(): void {
    this.parser.end();
    if (!this.rootSeen) {
      throw new KmyCorruptFileError("there is no root element");
    }
    if (this.stack.length > 0) {
      throw new KmyCorruptFileError("the document ends inside an element");
    }
  }
}

/** The document bytes, decoded as UTF-8 piece by piece and tokenized. */
export class KmyXmlByteTokenizer {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly tokenizer: KmyXmlTokenizer;

  constructor(events: KmyXmlEvents) {
    this.tokenizer = new KmyXmlTokenizer(events);
  }

  write(bytes: Buffer): void {
    for (let offset = 0; offset < bytes.length; offset += DECODE_SLICE_BYTES) {
      const slice = bytes.subarray(offset, offset + DECODE_SLICE_BYTES);
      this.tokenizer.write(this.decoder.decode(slice, { stream: true }));
    }
  }

  end(): void {
    this.tokenizer.write(this.decoder.decode());
    this.tokenizer.end();
  }
}

/** One whole filtered document, synchronously (specs and small inputs). */
export function tokenizeKmyXml(xml: Buffer, events: KmyXmlEvents): void {
  const tokenizer = new KmyXmlByteTokenizer(events);
  tokenizer.write(xml);
  tokenizer.end();
}
