import { readFile } from "node:fs/promises";

export type PflExport = Readonly<Record<string, unknown>>;

export async function readPflExport(path: string): Promise<PflExport> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch {
    throw new Error(`cannot read input file: ${path}`);
  }

  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`input file is not valid JSON: ${path}`);
  }

  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("input JSON must contain an object at the top level");
  }
  return value as PflExport;
}
