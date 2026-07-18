// Lazy ZIP reader; defers decompression to entry-read time via `DecompressionStream`.

import { fail } from "./errors";

/** A single ZIP entry as recorded in the central directory. */
export type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number; // 0 = stored, 8 = deflate; anything else is rejected
  localHeaderOffset: number;
  flags: number;
};

/** Lazy ZIP reader keyed by entry name. */
export type ZipReader = {
  entries: Map<string, ZipEntry>;
  read(name: string): Promise<Uint8Array | undefined>;
  readText(name: string): Promise<string | undefined>;
};

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const ZIP64_SENTINEL = 0xffffffff;
const textDecoder = new TextDecoder("utf-8");

// EOCD sits at the file end. Min 22 bytes; up to 65535 bytes of comment may follow.
const EOCD_MAX_SCAN = 22 + 65535;
const MAX_ENTRY_UNCOMPRESSED = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;

/** Open an EPUB-style ZIP. Enforces the EPUB-specific `mimetype` entry up-front; everything else is read on demand. */
export async function openZip(blob: Blob): Promise<ZipReader> {
  const eocd = await findEocd(blob);
  const entries = await readCentralDirectory(blob, eocd.cdOffset, eocd.cdSize, eocd.entryCount);

  const mimeEntry = entries.get("mimetype");
  if (!mimeEntry) {
    fail("missing-mimetype", "The ZIP archive is missing the required `mimetype` entry. This file may not be an EPUB.");
  }
  const mime = decodeText(await readEntry(blob, mimeEntry)).trim();
  if (mime !== "application/epub+zip") {
    fail("wrong-mimetype", `Expected the \`mimetype\` entry to be "application/epub+zip" but found "${mime}".`, {
      path: "mimetype",
    });
  }

  return {
    entries,
    async read(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      return readEntry(blob, entry);
    },
    async readText(name) {
      const entry = entries.get(name);
      if (!entry) return undefined;
      const text = decodeText(await readEntry(blob, entry));
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
    },
  };
}

/** Locate the EOCD record. Walks backward from EOF because the spec allows up to 64KB of trailing comment. */
async function findEocd(blob: Blob): Promise<{ cdOffset: number; cdSize: number; entryCount: number }> {
  if (blob.size < 22) {
    fail("not-zip", "The file is too small to be a valid ZIP archive.");
  }

  const tailLen = Math.min(blob.size, EOCD_MAX_SCAN);
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  } catch (cause) {
    fail("not-zip", "Could not read the end of the file.", { cause });
  }

  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) {
      const view = new DataView(buf.buffer, buf.byteOffset + i, 22);
      // Confirm via DataView too — guards against false matches inside the comment field.
      if (view.getUint32(0, true) !== EOCD_SIG) continue;
      const commentLength = view.getUint16(20, true);
      if (i + 22 + commentLength !== buf.length) continue;
      const disk = view.getUint16(4, true);
      const centralDisk = view.getUint16(6, true);
      const entriesOnDisk = view.getUint16(8, true);
      const entryCount = view.getUint16(10, true);
      if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
        fail("not-zip", "Multi-disk ZIP archives are not supported.");
      }
      const cdSize = view.getUint32(12, true);
      const cdOffset = view.getUint32(16, true);
      if (cdSize === ZIP64_SENTINEL || cdOffset === ZIP64_SENTINEL) {
        fail("not-zip", "ZIP64 archives are not supported.");
      }
      if (cdOffset + cdSize > blob.size || cdOffset + cdSize > blob.size - tailLen + i) {
        fail("not-zip", "The ZIP central directory points outside the archive.");
      }
      return { cdOffset, cdSize, entryCount };
    }
  }
  fail("not-zip", "The file is not a valid ZIP archive (no end-of-central-directory record found).");
}

/** Read every central-directory entry into an in-memory index. The CD is small (a few KB) so eager load is fine. */
async function readCentralDirectory(
  blob: Blob,
  offset: number,
  size: number,
  expectedEntries: number,
): Promise<Map<string, ZipEntry>> {
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
  } catch (cause) {
    fail("not-zip", "Could not read the central directory.", { cause });
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const entries = new Map<string, ZipEntry>();
  let p = 0;
  let totalUncompressed = 0;

  while (p + 46 <= buf.length) {
    if (view.getUint32(p, true) !== CD_SIG) break;

    const method = view.getUint16(p + 10, true);
    const flags = view.getUint16(p + 8, true);
    const compressedSize = view.getUint32(p + 20, true);
    const uncompressedSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localHeaderOffset = view.getUint32(p + 42, true);
    const recordEnd = p + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > buf.length) fail("not-zip", "A central-directory entry is truncated.");

    if (
      compressedSize === ZIP64_SENTINEL ||
      uncompressedSize === ZIP64_SENTINEL ||
      localHeaderOffset === ZIP64_SENTINEL
    ) {
      fail("not-zip", "ZIP64 archives are not supported.");
    }
    if ((flags & 1) !== 0) fail("not-zip", "Encrypted ZIP entries are not supported.");
    if (method !== 0 && method !== 8) fail("not-zip", `Unsupported compression method ${method}.`);
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
      fail("not-zip", `ZIP entry exceeds the ${MAX_ENTRY_UNCOMPRESSED}-byte safety limit.`);
    }
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
      fail("not-zip", `ZIP contents exceed the ${MAX_TOTAL_UNCOMPRESSED}-byte safety limit.`);
    }

    const name = decodeText(buf.subarray(p + 46, p + 46 + nameLen));
    if (entries.has(name)) fail("not-zip", `The ZIP contains duplicate entries named "${name}".`);
    entries.set(name, { name, compressedSize, uncompressedSize, method, localHeaderOffset, flags });

    p = recordEnd;
  }

  if (entries.size !== expectedEntries || p !== buf.length) {
    fail("not-zip", "The ZIP central directory is incomplete or inconsistent.");
  }

  return entries;
}

/** Inflate one entry. Reads the local file header to find the data start — the CD's extraLen and the LFH's extraLen can differ. */
async function readEntry(blob: Blob, entry: ZipEntry): Promise<Uint8Array> {
  let header: Uint8Array;
  try {
    header = new Uint8Array(await blob.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30).arrayBuffer());
  } catch (cause) {
    fail("not-zip", `Could not read the local file header for "${entry.name}".`, { cause });
  }
  if (header.length < 30) {
    fail("not-zip", `Truncated local file header for "${entry.name}".`);
  }

  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint32(0, true) !== LFH_SIG) {
    fail("not-zip", `Bad local file header signature for "${entry.name}".`);
  }
  const nameLen = view.getUint16(26, true);
  const extraLen = view.getUint16(28, true);
  const localFlags = view.getUint16(6, true);
  const localMethod = view.getUint16(8, true);
  if (localFlags !== entry.flags || localMethod !== entry.method) {
    fail("not-zip", `Local and central ZIP metadata disagree for "${entry.name}".`);
  }
  const dataStart = entry.localHeaderOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < 0 || dataEnd > blob.size || dataEnd < dataStart) {
    fail("not-zip", `The data range for "${entry.name}" points outside the archive.`);
  }

  let compressed: Uint8Array;
  try {
    compressed = new Uint8Array(await blob.slice(dataStart, dataEnd).arrayBuffer());
  } catch (cause) {
    fail("not-zip", `Could not read the data for "${entry.name}".`, { cause });
  }

  if (entry.method === 0) {
    if (compressed.length !== entry.uncompressedSize) fail("not-zip", `Stored size mismatch for "${entry.name}".`);
    return compressed;
  }
  if (entry.method === 8) {
    try {
      const inflated = await inflateRaw(compressed);
      if (inflated.length !== entry.uncompressedSize) fail("not-zip", `Inflated size mismatch for "${entry.name}".`);
      return inflated;
    } catch (cause) {
      fail("not-zip", `Failed to inflate "${entry.name}".`, { cause });
    }
  }
  fail("not-zip", `Unsupported compression method ${entry.method} for "${entry.name}".`);
}

function decodeText(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  if (!("DecompressionStream" in globalThis)) {
    fail("not-zip", "This environment does not support the DecompressionStream API required for EPUB decompression.");
  }

  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
