import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function readJsonFile(path: string): Promise<unknown> {
  const text = await readFile(path, "utf8");
  return JSON.parse(text) as unknown;
}

export async function readJsonFileOrNull(path: string): Promise<unknown | null> {
  try {
    return await readJsonFile(path);
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await writeTextFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextFile(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${Date.now()}.tmp`,
  );
  await writeFile(temporary, value, "utf8");
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!isReplaceFailure(error)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isReplaceFailure(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "EPERM";
}
