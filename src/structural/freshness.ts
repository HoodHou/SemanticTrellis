import { extname } from "node:path";

export const EXTRACTOR_FINGERPRINT = [
  "csharp:ast-grep-napi-0.45.1-csharp-0.0.6-v4",
  "lua:ast-grep-napi-0.45.1-lua-0.0.7-v2",
  "markdown:markdown-v1",
  "python:ast-grep-napi-0.45.1-python-0.0.6-v1",
  "strellis-json:strellis-json-v1",
  "typescript:typescript-compiler-5.9.3-v4",
].join("\n");

const STRUCTURAL_EXTENSIONS = new Set([
  ".cjs",
  ".cs",
  ".js",
  ".jsx",
  ".lua",
  ".md",
  ".mjs",
  ".py",
  ".pyi",
  ".ts",
  ".tsx",
]);

export function pathMayHaveStructure(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").toLowerCase();
  if (normalized.endsWith(".strellis.json")) return true;
  if (normalized.endsWith(".json")) return false;
  return STRUCTURAL_EXTENSIONS.has(extname(normalized));
}
