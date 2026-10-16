import { basename } from "node:path";
import type {
  FileContribution,
  StructuralDiagnostic,
  StructuralSymbol,
} from "../../domain/structural.js";
import type { LanguageAdapter, LanguageExtractionInput } from "../../ports/language-adapter.js";

const VERSION = "strellis-json-v1";
const METADATA_KEYS = new Set([
  "schemaVersion",
  "kind",
  "source",
  "producer",
  "omissions",
  "warnings",
  "content",
]);

interface SheetShape {
  name: string;
  fields: string[];
  ids: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lineCountOf(source: string): number {
  if (source.length === 0) return 1;
  const lines = source.split(/\r?\n/);
  return lines.at(-1) === "" ? Math.max(1, lines.length - 1) : lines.length;
}

function lineOf(source: string, needle: string): number {
  const lines = source.split(/\r?\n/);
  const index = lines.findIndex((line) => line.includes(needle));
  return index >= 0 ? index + 1 : 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function fieldNames(value: unknown): string[] {
  if (Array.isArray(value)) {
    return unique(value.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (isRecord(item) && typeof item.name === "string") return [item.name];
      return [];
    })).slice(0, 80);
  }
  if (isRecord(value)) return unique(Object.keys(value)).slice(0, 80);
  return [];
}

function rowIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = item.id ?? item.ID ?? item.Id;
    return typeof id === "string" || typeof id === "number" ? [String(id)] : [];
  })).slice(0, 40);
}

function sheetFromValue(value: unknown, fallback: string): SheetShape[] {
  if (!isRecord(value)) return [];
  const name = typeof value.name === "string" && value.name.trim().length > 0
    ? value.name.trim()
    : fallback;
  return [{
    name,
    fields: fieldNames(value.fields ?? value.columns ?? value.schema),
    ids: rowIds(value.rows ?? value.records ?? value.items),
  }];
}

function sheetsFrom(content: unknown): SheetShape[] {
  if (Array.isArray(content)) {
    return [{
      name: "records",
      fields: unique(content.flatMap((item) => isRecord(item) ? Object.keys(item) : [])).slice(0, 80),
      ids: rowIds(content),
    }];
  }
  const record = isRecord(content) ? content : null;
  if (record === null) return [];
  const explicit = record.sheets ?? record.tables;
  if (Array.isArray(explicit)) {
    return explicit.flatMap((item, index) => sheetFromValue(item, `sheet ${index + 1}`)).slice(0, 40);
  }
  const schema = isRecord(record.schema) ? record.schema : null;
  if (schema !== null) {
    return [{ name: "schema", fields: fieldNames(schema.fields ?? schema.properties ?? schema), ids: [] }];
  }
  const sheets: SheetShape[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (METADATA_KEYS.has(key) || !Array.isArray(value) || value.length === 0) continue;
    if (!value.every((item) => isRecord(item))) continue;
    sheets.push({
      name: key,
      fields: unique(value.flatMap((item) => Object.keys(isRecord(item) ? item : {}))).slice(0, 80),
      ids: rowIds(value),
    });
  }
  return sheets.slice(0, 40);
}

export class StrellisJsonLanguageAdapter implements LanguageAdapter {
  readonly id = "strellis-json";
  readonly version = VERSION;
  readonly extensions = new Set([".json"]);

  matches(path: string): boolean {
    return path.toLowerCase().endsWith(".strellis.json");
  }

  extract(input: LanguageExtractionInput): FileContribution {
    const totalLines = lineCountOf(input.source);
    const fileSymbol: StructuralSymbol = {
      id: `${input.path}#file`,
      path: input.path,
      name: basename(input.path),
      qualifiedName: input.path,
      kind: "file",
      span: { startLine: 1, startColumn: 1, endLine: totalLines, endColumn: 1 },
      signature: input.path,
      parentId: null,
      callArity: null,
      partial: false,
    };
    const diagnostics: StructuralDiagnostic[] = [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.source) as unknown;
    } catch (error) {
      diagnostics.push({
        path: input.path,
        code: "strellis-json-parse",
        message: error instanceof Error ? error.message : String(error),
        line: 1,
        column: 1,
      });
      return this.contribution(input, [fileSymbol], diagnostics);
    }
    const root = isRecord(parsed) ? parsed : null;
    if (root === null) {
      diagnostics.push({
        path: input.path,
        code: "strellis-json-shape",
        message: "Projection JSON must be an object.",
        line: 1,
        column: 1,
      });
      return this.contribution(input, [fileSymbol], diagnostics);
    }
    const symbols: StructuralSymbol[] = [fileSymbol];
    const source = isRecord(root.source) ? root.source : null;
    const sourcePath = typeof source?.path === "string" ? source.path : null;
    const artifactName = sourcePath === null ? null : basename(sourcePath);
    const artifact = artifactName === null ? null : this.symbol(
      input.path,
      artifactName,
      artifactName,
      "module",
      lineOf(input.source, artifactName),
      fileSymbol.id,
    );
    if (artifact !== null) symbols.push(artifact);
    const content = "content" in root ? root.content : root;
    const parent = artifact ?? fileSymbol;
    for (const sheet of sheetsFrom(content)) {
      const sheetSymbol = this.symbol(
        input.path,
        sheet.name,
        `${parent.qualifiedName}/${sheet.name}`,
        "sheet",
        lineOf(input.source, sheet.name),
        parent.id,
      );
      symbols.push(sheetSymbol);
      for (const field of sheet.fields) {
        if (field === sheet.name) continue;
        symbols.push(this.symbol(
          input.path,
          field,
          `${sheetSymbol.qualifiedName}/${field}`,
          "field",
          lineOf(input.source, field),
          sheetSymbol.id,
        ));
      }
      for (const id of sheet.ids) {
        symbols.push(this.symbol(
          input.path,
          id,
          `${sheetSymbol.qualifiedName}/${id}`,
          "variable",
          lineOf(input.source, id),
          sheetSymbol.id,
        ));
      }
    }
    if (symbols.length > 300) {
      diagnostics.push({
        path: input.path,
        code: "strellis-json-truncated",
        message: "Projection symbol extraction stopped at 300 symbols.",
        line: 1,
        column: 1,
      });
    }
    return this.contribution(input, symbols.slice(0, 300), diagnostics);
  }

  private symbol(
    path: string,
    name: string,
    qualifiedName: string,
    kind: StructuralSymbol["kind"],
    line: number,
    parentId: string,
  ): StructuralSymbol {
    return {
      id: `${path}#${kind}:${qualifiedName}`,
      path,
      name,
      qualifiedName,
      kind,
      span: { startLine: line, startColumn: 1, endLine: line, endColumn: Math.max(1, name.length) },
      signature: qualifiedName,
      parentId,
      callArity: null,
      partial: false,
    };
  }

  private contribution(
    input: LanguageExtractionInput,
    symbols: StructuralSymbol[],
    diagnostics: StructuralDiagnostic[],
  ): FileContribution {
    return {
      path: input.path,
      hash: input.hash,
      sourceSize: input.size ?? Buffer.byteLength(input.source, "utf8"),
      sourceMtimeMs: input.mtimeMs ?? 0,
      language: this.id,
      extractorVersion: this.version,
      symbols,
      references: [],
      diagnostics,
    };
  }
}
