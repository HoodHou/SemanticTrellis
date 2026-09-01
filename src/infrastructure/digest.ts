import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  const input = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(input)
      .sort()
      .map((key) => [key, canonicalValue(input[key])]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function digestJson(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function digestBytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function digestFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
