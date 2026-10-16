import { basename, posix } from "node:path";
import type {
  FileContribution,
  SourceSpan,
  StructuralReference,
  StructuralSymbol,
} from "../../domain/structural.js";
import type { LanguageAdapter, LanguageExtractionInput } from "../../ports/language-adapter.js";

const VERSION = "markdown-v1";

interface OpenHeading {
  level: number;
  symbolIndex: number;
}

function lineCountOf(source: string): number {
  if (source.length === 0) return 1;
  const lines = source.split(/\r?\n/);
  return lines.at(-1) === "" ? Math.max(1, lines.length - 1) : lines.length;
}

function splitRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim()).filter((cell) => cell.length > 0);
}

function isTableSeparator(line: string): boolean {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isFence(line: string): boolean {
  return /^\s*(```|~~~)/.test(line);
}

function resolveLink(from: string, target: string): string | null {
  const trimmed = target.trim().replace(/^<|>$/g, "");
  if (trimmed.length === 0 || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed)) return null;
  const hashIndex = trimmed.indexOf("#");
  const pathPart = hashIndex >= 0 ? trimmed.slice(0, hashIndex) : trimmed;
  const anchor = hashIndex >= 0 ? trimmed.slice(hashIndex + 1) : "";
  if (pathPart.length === 0) return anchor.length > 0 ? `#${anchor}` : null;
  const joined = posix.normalize(posix.join(posix.dirname(from), pathPart));
  if (joined.startsWith("../") || joined === "..") return null;
  return anchor.length > 0 ? `${joined}#${anchor}` : joined;
}

function closeHeadings(
  open: OpenHeading[],
  symbols: StructuralSymbol[],
  level: number,
  line: number,
): void {
  while (open.length > 0 && (open.at(-1)?.level ?? 0) >= level) {
    const closed = open.pop();
    const symbol = closed === undefined ? undefined : symbols[closed.symbolIndex];
    if (symbol !== undefined) {
      symbol.span = {
        ...symbol.span,
        endLine: Math.max(symbol.span.startLine, line - 1),
      };
    }
  }
}

export class MarkdownLanguageAdapter implements LanguageAdapter {
  readonly id = "markdown";
  readonly version = VERSION;
  readonly extensions = new Set([".md"]);

  extract(input: LanguageExtractionInput): FileContribution {
    const lines = input.source.split(/\r?\n/);
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
    const symbols: StructuralSymbol[] = [fileSymbol];
    const references: StructuralReference[] = [];
    const open: OpenHeading[] = [];
    const duplicateCounts = new Map<string, number>();
    const pendingLinks: Array<{ line: number; column: number; target: string }> = [];
    let inFence = false;
    let tableOrdinal = 0;

    const pushSymbol = (
      name: string,
      qualifiedName: string,
      kind: StructuralSymbol["kind"],
      span: SourceSpan,
      parentId: string,
    ): StructuralSymbol => {
      const duplicateKey = `${kind}:${qualifiedName}`;
      const ordinal = (duplicateCounts.get(duplicateKey) ?? 0) + 1;
      duplicateCounts.set(duplicateKey, ordinal);
      const suffix = ordinal === 1 ? "" : `~${ordinal}`;
      const symbol: StructuralSymbol = {
        id: `${input.path}#${kind}:${qualifiedName}${suffix}`,
        path: input.path,
        name,
        qualifiedName,
        kind,
        span,
        signature: name,
        parentId,
        callArity: null,
        partial: false,
      };
      symbols.push(symbol);
      return symbol;
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const lineNumber = index + 1;
      if (isFence(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (heading !== null) {
        const level = heading[1]?.length ?? 1;
        const name = (heading[2] ?? "").replace(/\s+#+\s*$/, "").trim();
        if (name.length === 0) continue;
        closeHeadings(open, symbols, level, lineNumber);
        const parent = [...open].reverse().find((item) => item.level < level);
        const parentSymbol = parent === undefined ? fileSymbol : symbols[parent.symbolIndex] ?? fileSymbol;
        const qualifiedName = parentSymbol.kind === "heading"
          ? `${parentSymbol.qualifiedName}/${name}`
          : name;
        const symbol = pushSymbol(name, qualifiedName, "heading", {
          startLine: lineNumber,
          startColumn: line.indexOf("#") + 1,
          endLine: lineNumber,
          endColumn: line.length + 1,
        }, parentSymbol.id);
        open.push({ level, symbolIndex: symbols.indexOf(symbol) });
        continue;
      }
      const next = lines[index + 1] ?? "";
      if (line.includes("|") && isTableSeparator(next)) {
        tableOrdinal += 1;
        const headers = splitRow(line);
        const parentHeading = [...open].at(-1);
        const parentSymbol = parentHeading === undefined
          ? fileSymbol
          : symbols[parentHeading.symbolIndex] ?? fileSymbol;
        const name = parentSymbol.kind === "heading" ? `${parentSymbol.name} table` : `table ${tableOrdinal}`;
        const qualifiedName = parentSymbol.kind === "heading"
          ? `${parentSymbol.qualifiedName}/${name}`
          : name;
        let cursor = index + 2;
        while (cursor < lines.length && (lines[cursor] ?? "").includes("|")) cursor += 1;
        const table = pushSymbol(name, qualifiedName, "table", {
          startLine: lineNumber,
          startColumn: 1,
          endLine: cursor,
          endColumn: 1,
        }, parentSymbol.id);
        headers.forEach((header, headerIndex) => {
          pushSymbol(header, `${table.qualifiedName}/${header}`, "field", {
            startLine: lineNumber,
            startColumn: headerIndex + 1,
            endLine: lineNumber,
            endColumn: headerIndex + 1,
          }, table.id);
        });
        index = cursor - 1;
        continue;
      }
      const linkPattern = /\[[^\]]*]\(([^)\s]+)\)|<([^>\s]+\.md[^>\s]*)>/gi;
      for (const match of line.matchAll(linkPattern)) {
        const raw = match[1] ?? match[2] ?? "";
        const target = resolveLink(input.path, raw);
        if (target === null) continue;
        pendingLinks.push({
          line: lineNumber,
          column: (match.index ?? 0) + 1,
          target,
        });
      }
    }
    closeHeadings(open, symbols, 1, totalLines + 1);
    for (const symbol of symbols) {
      if (symbol.kind === "heading" && symbol.span.endLine < symbol.span.startLine) {
        symbol.span = { ...symbol.span, endLine: symbol.span.startLine };
      }
    }

    const referenceCounts = new Map<string, number>();
    for (const link of pendingLinks) {
      const owner = symbols
        .filter((symbol) =>
          symbol.kind !== "file" &&
          symbol.span.startLine <= link.line &&
          symbol.span.endLine >= link.line,
        )
        .sort((left, right) =>
          (left.span.endLine - left.span.startLine) - (right.span.endLine - right.span.startLine),
        )[0]?.id ?? fileSymbol.id;
      const key = `${owner}|references|${link.target}`;
      const ordinal = referenceCounts.get(key) ?? 0;
      referenceCounts.set(key, ordinal + 1);
      references.push({
        id: `${owner}#ref:references:${link.target}:${ordinal}`,
        path: input.path,
        ownerSymbolId: owner,
        kind: "references",
        targetName: link.target,
        targetQualifier: null,
        argumentCount: null,
        line: link.line,
        column: link.column,
      });
    }

    return {
      path: input.path,
      hash: input.hash,
      sourceSize: input.size ?? Buffer.byteLength(input.source, "utf8"),
      sourceMtimeMs: input.mtimeMs ?? 0,
      language: this.id,
      extractorVersion: this.version,
      symbols,
      references,
      diagnostics: [],
    };
  }
}
