import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { digestBytes } from "./digest.js";

interface CachedSource {
  hash: string;
  size: number;
  mtimeMs: number;
  source: string;
}

const sourceCache = new Map<string, CachedSource>();

export class SourceHashMismatchError extends Error {
  readonly path: string;
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(path: string, expectedHash: string, actualHash: string) {
    super(`Structural index is stale for ${path}.`);
    this.name = "SourceHashMismatchError";
    this.path = path;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

export async function readVerifiedSource(
  root: string,
  path: string,
  expectedHash: string,
): Promise<string> {
  const absolutePath = resolve(root, path);
  const fileStat = await stat(absolutePath);
  const cached = sourceCache.get(absolutePath);
  if (
    cached?.hash === expectedHash &&
    cached.size === fileStat.size &&
    cached.mtimeMs === fileStat.mtimeMs
  ) {
    return cached.source;
  }

  const bytes = await readFile(absolutePath);
  const actualHash = digestBytes(bytes);
  if (actualHash !== expectedHash) {
    sourceCache.delete(absolutePath);
    throw new SourceHashMismatchError(path, expectedHash, actualHash);
  }
  const source = bytes.toString("utf8");
  sourceCache.set(absolutePath, {
    hash: actualHash,
    size: fileStat.size,
    mtimeMs: fileStat.mtimeMs,
    source,
  });
  return source;
}

export function rememberVerifiedSource(
  root: string,
  path: string,
  hash: string,
  size: number,
  mtimeMs: number,
  source: string,
): void {
  sourceCache.set(resolve(root, path), { hash, size, mtimeMs, source });
}
