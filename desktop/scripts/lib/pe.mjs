import { Buffer } from "node:buffer";
import fs from "node:fs";

/**
 * Just enough of the Windows executable format to answer three questions
 * about a .exe or .dll: which processor it is built for, which DLLs it
 * imports by name, and whether it carries an Authenticode signature. The
 * VC++ runtime step uses the first two to prove that the staged PostgreSQL
 * needs nothing the installer does not carry; the signed-installer step uses
 * the third.
 */

export const MACHINE_X64 = 0x8664;
const PE32_PLUS = 0x20b;
const IMPORT_DIRECTORY = 1;
const SECURITY_DIRECTORY = 4;

function header(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) {
    return null;
  }
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.readUInt32LE(pe) !== 0x00004550) {
    return null;
  }
  return {
    pe,
    machine: buffer.readUInt16LE(pe + 4),
    sections: buffer.readUInt16LE(pe + 6),
    optionalSize: buffer.readUInt16LE(pe + 20),
    optional: pe + 24,
  };
}

/** The COFF machine type, or null when the bytes are not a PE image. */
export function peMachine(buffer) {
  return header(buffer)?.machine ?? null;
}

/** The DLL names in the image's import table, lower-cased; [] when it has none. */
export function peImports(buffer) {
  const h = header(buffer);
  if (h === null) {
    throw new Error("not a PE image");
  }
  const plus = buffer.readUInt16LE(h.optional) === PE32_PLUS;
  const directories = h.optional + (plus ? 112 : 96);
  const count = buffer.readUInt32LE(directories - 4);
  if (count <= IMPORT_DIRECTORY) {
    return [];
  }
  const importRva = buffer.readUInt32LE(directories + IMPORT_DIRECTORY * 8);
  if (importRva === 0) {
    return [];
  }
  const sectionTable = h.optional + h.optionalSize;
  const offsetOf = (rva) => {
    for (let i = 0; i < h.sections; i += 1) {
      const at = sectionTable + i * 40;
      const size = Math.max(
        buffer.readUInt32LE(at + 8),
        buffer.readUInt32LE(at + 16),
      );
      const start = buffer.readUInt32LE(at + 12);
      if (rva >= start && rva < start + size) {
        return rva - start + buffer.readUInt32LE(at + 20);
      }
    }
    throw new Error(`the address 0x${rva.toString(16)} is in no section`);
  };
  const names = [];
  for (let at = offsetOf(importRva); ; at += 20) {
    const nameRva = buffer.readUInt32LE(at + 12);
    if (nameRva === 0) {
      break;
    }
    const from = offsetOf(nameRva);
    const to = buffer.indexOf(0, from);
    names.push(buffer.toString("latin1", from, to).toLowerCase());
  }
  return names;
}

/**
 * Whether the image has an attribute certificate table (the Authenticode
 * signature): a non-empty security directory that lies inside the file.
 * Unlike every other data directory, its address is a file offset, not an
 * RVA. It says nothing about who signed or whether the signature verifies;
 * that is Windows' check (Get-AuthenticodeSignature). `fileSize` is the
 * whole file's size when `buffer` holds only its start (the headers).
 */
export function peHasSignature(buffer, fileSize = buffer.length) {
  const h = header(buffer);
  if (h === null) {
    throw new Error("not a PE image");
  }
  const plus = buffer.readUInt16LE(h.optional) === PE32_PLUS;
  const directories = h.optional + (plus ? 112 : 96);
  if (buffer.readUInt32LE(directories - 4) <= SECURITY_DIRECTORY) {
    return false;
  }
  const at = directories + SECURITY_DIRECTORY * 8;
  const offset = buffer.readUInt32LE(at);
  const size = buffer.readUInt32LE(at + 4);
  return offset !== 0 && size !== 0 && offset + size <= fileSize;
}

/** peHasSignature for a file, reading only its headers. */
export function fileHasSignature(file) {
  const fd = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const read = fs.readSync(fd, head, 0, head.length, 0);
    return peHasSignature(head.subarray(0, read), fs.fstatSync(fd).size);
  } finally {
    fs.closeSync(fd);
  }
}

export function readImports(file) {
  return peImports(fs.readFileSync(file));
}
