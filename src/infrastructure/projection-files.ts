import { lstat, readFile } from "node:fs/promises";
import { digestFile } from "./digest.js";
import { writeTextFile } from "./json-store.js";

function missing(error: unknown): boolean {
  return error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT";
}

export async function readProjectionText(path: string): Promise<string> {
  const bytes = await readFile(path);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Projection files must be valid UTF-8 text.");
  }
}

export async function existingFileDigest(path: string): Promise<string | null> {
  try {
    const fileStat = await lstat(path);
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error("Projection target must be a regular non-symbolic-link file.");
    }
    return digestFile(path);
  } catch (error) {
    if (missing(error)) return null;
    throw error;
  }
}

export async function writeProjectionText(path: string, content: string): Promise<void> {
  await existingFileDigest(path);
  await writeTextFile(path, content);
}
