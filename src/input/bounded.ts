import { open } from "node:fs/promises";

/**
 * Shared transport ceiling for every input document kind: pfl exports and
 * yuurei traces are both untrusted input bounded at 16 MiB per document
 * (docs/pfl-export-contract.md, docs/yuurei-trace-contract.md).
 */
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;

/** Thrown by the readers below when the input exceeds MAX_INPUT_BYTES. */
export class InputTooLargeError extends Error {}

/**
 * Reads at most MAX_INPUT_BYTES bytes. Regular files are rejected by size
 * before reading; pipes and devices are read in chunks and cut off at the
 * limit, so an oversized or endless input never has to fit in memory.
 */
export async function readBounded(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (info.isFile() && info.size > MAX_INPUT_BYTES)
      throw new InputTooLargeError();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_INPUT_BYTES) throw new InputTooLargeError();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

/** Reads standard input under the same byte ceiling as file input. */
export async function readBoundedStdin(
  stream: AsyncIterable<Buffer | string> = process.stdin,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Chunks are strings when a consumer already called setEncoding('utf8'):
  // re-encode so the ceiling counts bytes, not UTF-16 code units.
  for await (const chunk of stream) {
    const buffer =
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    total += buffer.length;
    if (total > MAX_INPUT_BYTES) {
      const destroy = (stream as { destroy?: unknown }).destroy;
      if (typeof destroy === "function") (destroy as () => void).call(stream);
      throw new InputTooLargeError();
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}
