import type { FileContribution } from "../domain/structural.js";

export interface LanguageExtractionInput {
  path: string;
  hash: string;
  size?: number | undefined;
  mtimeMs?: number | undefined;
  source: string;
}

export interface LanguageAdapter {
  id: string;
  version: string;
  extensions: ReadonlySet<string>;
  extract(input: LanguageExtractionInput): FileContribution;
}
