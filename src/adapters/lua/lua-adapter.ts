import { basename } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import type {
  FileContribution,
  SourceSpan,
  StructuralCallArity,
  StructuralDiagnostic,
  StructuralReference,
  StructuralReferenceKind,
  StructuralSymbol,
  StructuralSymbolKind,
} from "../../domain/structural.js";
import type { LanguageAdapter, LanguageExtractionInput } from "../../ports/language-adapter.js";
import { ensureAstGrepLanguages } from "../ast-grep-runtime.js";

const VERSION = "ast-grep-napi-0.45.1-lua-0.0.7-v2";
const EXTENSIONS = new Set([".lua"]);

interface DeclarationCandidate {
  node: SgNode;
  name: string;
  qualifiedParts: string[] | null;
  kind: StructuralSymbolKind;
  opensScope: boolean;
  startOffset: number;
  endOffset: number;
  callArity: StructuralCallArity | null;
}

interface ScopeRecord {
  startOffset: number;
  endOffset: number;
  names: string[];
  symbol: StructuralSymbol;
}

interface ReferenceCandidate {
  node: SgNode;
  kind: StructuralReferenceKind;
  targetName: string;
  targetQualifier: string | null;
  argumentCount: number | null;
}

function nodesOfKind(root: SgNode, kind: string): SgNode[] {
  return root.findAll({ rule: { kind } });
}

function safeField(node: SgNode, name: string): SgNode | null {
  try {
    return node.field(name);
  } catch {
    return null;
  }
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function spanOf(node: SgNode): SourceSpan {
  const range = node.range();
  return {
    startLine: range.start.line + 1,
    startColumn: range.start.column + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.column + 1,
  };
}

function signatureOf(node: SgNode): string {
  const body = safeField(node, "body");
  if (body === null) return compact(node.text()).slice(0, 320);
  const length = Math.max(0, body.range().start.index - node.range().start.index);
  return compact(node.text().slice(0, length)).slice(0, 320);
}

function indexParts(node: SgNode | null): string[] | null {
  if (node === null) return null;
  if (node.kind() === "identifier") return [node.text().trim()];
  if (node.kind() === "dot_index_expression") {
    const table = indexParts(safeField(node, "table"));
    const field = safeField(node, "field")?.text().trim();
    return table !== null && field ? [...table, field] : null;
  }
  if (node.kind() === "method_index_expression") {
    const table = indexParts(safeField(node, "table"));
    const method = safeField(node, "method")?.text().trim();
    return table !== null && method ? [...table, method] : null;
  }
  return null;
}

function parameterArity(node: SgNode): StructuralCallArity | null {
  const parameters = safeField(node, "parameters");
  if (parameters === null) return null;
  const values = parameters.children().filter((child) => child.isNamed());
  const variadic = values.some((child) => child.kind() === "vararg_expression");
  const fixed = values.filter((child) => child.kind() !== "vararg_expression").length;
  return { min: fixed, max: variadic ? null : fixed };
}

function assignedFunctionName(node: SgNode): string[] | null {
  const expressions = node.parent();
  const assignment = expressions?.kind() === "expression_list" ? expressions.parent() : null;
  if (assignment?.kind() !== "assignment_statement") return null;
  const firstExpression = expressions?.children().find((child) => child.isNamed());
  if (firstExpression?.id() !== node.id()) return null;
  return indexParts(safeField(assignment, "name"));
}

function stringValue(node: SgNode): string | null {
  if (node.kind() !== "string") return null;
  const content = node.children().find((child) => child.kind() === "string_content")?.text();
  if (content !== undefined) return content;
  const text = node.text().trim();
  if ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text.startsWith("[[") && text.endsWith("]]")) return text.slice(2, -2);
  return null;
}

function callTarget(node: SgNode): { name: string; qualifier: string | null } | null {
  const nameNode = safeField(node, "name");
  const parts = indexParts(nameNode);
  if (parts === null || parts.length === 0) return null;
  const name = parts.at(-1) ?? "";
  return {
    name,
    qualifier: parts.length > 1 ? parts.join(".") : null,
  };
}

function callbackName(node: SgNode): string | null {
  const argumentsNode = node.parent();
  const call = argumentsNode?.kind() === "arguments" ? argumentsNode.parent() : null;
  if (call?.kind() !== "function_call") return null;
  const target = callTarget(call);
  if (target === null) return null;
  const argumentsValues = argumentsNode?.children().filter((child) => child.isNamed()) ?? [];
  const argumentIndex = argumentsValues.findIndex((argument) => argument.id() === node.id());
  if (argumentIndex < 0) return null;
  const label = argumentsValues[0] === undefined ? null : stringValue(argumentsValues[0]);
  return label === null
    ? `${target.name} callback ${argumentIndex + 1}`
    : `${target.name} ${JSON.stringify(label)}`;
}

function firstAssignedValue(node: SgNode): SgNode | null {
  return node.children()
    .find((child) => child.kind() === "expression_list")
    ?.children()
    .find((child) => child.isNamed()) ?? null;
}

function hasFunctionAncestor(node: SgNode): boolean {
  return node.ancestors().some((ancestor) =>
    ancestor.kind() === "function_declaration" || ancestor.kind() === "function_definition",
  );
}

function collectDeclarations(root: SgNode): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];
  for (const node of nodesOfKind(root, "function_declaration")) {
    const parts = indexParts(safeField(node, "name"));
    if (parts === null || parts.length === 0) continue;
    const range = node.range();
    candidates.push({
      node,
      name: parts.at(-1) ?? "function",
      qualifiedParts: parts.length > 1 ? parts : null,
      kind: parts.length > 1 ? "method" : "function",
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
      callArity: parameterArity(node),
    });
  }
  for (const node of nodesOfKind(root, "function_definition")) {
    const assigned = assignedFunctionName(node);
    const callback = assigned === null ? callbackName(node) : null;
    if (assigned === null && callback === null) continue;
    const range = node.range();
    const parts = assigned;
    candidates.push({
      node,
      name: parts?.at(-1) ?? callback ?? "callback",
      qualifiedParts: parts !== null && parts.length > 1 ? parts : null,
      kind: callback !== null ? "callback" : parts !== null && parts.length > 1 ? "method" : "function",
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
      callArity: parameterArity(node),
    });
  }
  for (const node of nodesOfKind(root, "assignment_statement")) {
    if (hasFunctionAncestor(node)) continue;
    const parts = indexParts(safeField(node, "name"));
    if (parts === null || parts.length === 0) continue;
    const value = firstAssignedValue(node);
    if (value?.kind() === "function_definition") continue;
    const range = node.range();
    const module = value?.kind() === "table_constructor" && parts.length === 1;
    candidates.push({
      node,
      name: parts.at(-1) ?? "value",
      qualifiedParts: parts.length > 1 ? parts : null,
      kind: module ? "module" : parts.length > 1 ? "field" : "variable",
      opensScope: false,
      startOffset: range.start.index,
      endOffset: range.end.index,
      callArity: null,
    });
  }
  return candidates.sort(
    (left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset,
  );
}

function buildSymbols(
  path: string,
  fileSymbol: StructuralSymbol,
  candidates: DeclarationCandidate[],
): { symbols: StructuralSymbol[]; scopes: ScopeRecord[] } {
  const symbols: StructuralSymbol[] = [fileSymbol];
  const scopes: ScopeRecord[] = [];
  const active: ScopeRecord[] = [];
  const duplicateCounts = new Map<string, number>();
  const byQualifiedName = new Map<string, StructuralSymbol>();
  for (const candidate of candidates) {
    while (
      active.length > 0 &&
      !(
        (active.at(-1)?.startOffset ?? 0) <= candidate.startOffset &&
        (active.at(-1)?.endOffset ?? 0) >= candidate.endOffset
      )
    ) {
      active.pop();
    }
    const lexicalParent = active.at(-1);
    const names = candidate.qualifiedParts ?? [
      ...(lexicalParent?.names ?? []),
      candidate.name,
    ];
    const qualifiedName = names.join(".");
    const explicitParent = candidate.qualifiedParts === null
      ? null
      : byQualifiedName.get(names.slice(0, -1).join(".")) ?? null;
    const parent = explicitParent ?? lexicalParent?.symbol ?? null;
    const duplicateKey = `${candidate.kind}:${qualifiedName}`;
    const ordinal = (duplicateCounts.get(duplicateKey) ?? 0) + 1;
    duplicateCounts.set(duplicateKey, ordinal);
    const suffix = ordinal === 1 ? "" : `~${ordinal}`;
    const symbol: StructuralSymbol = {
      id: `${path}#${candidate.kind}:${qualifiedName}${suffix}`,
      path,
      name: candidate.name,
      qualifiedName,
      kind: candidate.kind,
      span: spanOf(candidate.node),
      signature: signatureOf(candidate.node),
      parentId: parent?.id ?? fileSymbol.id,
      callArity: candidate.callArity,
      partial: false,
    };
    symbols.push(symbol);
    if (!byQualifiedName.has(qualifiedName)) byQualifiedName.set(qualifiedName, symbol);
    if (candidate.opensScope) {
      const scope = {
        startOffset: candidate.startOffset,
        endOffset: candidate.endOffset,
        names,
        symbol,
      };
      scopes.push(scope);
      active.push(scope);
    }
  }
  return { symbols, scopes };
}

function argumentValues(node: SgNode): SgNode[] {
  const argumentsNode = safeField(node, "arguments");
  if (argumentsNode === null) return [];
  if (argumentsNode.kind() === "arguments") {
    return argumentsNode.children().filter((child) => child.isNamed());
  }
  return argumentsNode.isNamed() ? [argumentsNode] : [];
}

function argumentCount(node: SgNode): number | null {
  const values = argumentValues(node);
  return values.some((value) => value.kind() === "vararg_expression") ? null : values.length;
}

function collectReferences(root: SgNode): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = [];
  for (const node of nodesOfKind(root, "function_call")) {
    const target = callTarget(node);
    if (target === null) continue;
    const values = argumentValues(node);
    if (target.name === "require") {
      const moduleName = values[0] === undefined ? null : stringValue(values[0]);
      if (moduleName !== null) {
        references.push({
          node,
          kind: "import",
          targetName: moduleName,
          targetQualifier: moduleName,
          argumentCount: null,
        });
        continue;
      }
    }
    references.push({
      node,
      kind: "invoke",
      targetName: target.name,
      targetQualifier: target.qualifier,
      argumentCount: argumentCount(node),
    });
  }
  return references.sort(
    (left, right) => left.node.range().start.index - right.node.range().start.index,
  );
}

function ownerFor(
  candidate: ReferenceCandidate,
  fileSymbol: StructuralSymbol,
  scopes: ScopeRecord[],
  state: { nextScope: number; active: ScopeRecord[] },
): StructuralSymbol {
  const range = candidate.node.range();
  while (
    state.nextScope < scopes.length &&
    (scopes[state.nextScope]?.startOffset ?? Number.POSITIVE_INFINITY) <= range.start.index
  ) {
    const scope = scopes[state.nextScope];
    if (scope !== undefined) state.active.push(scope);
    state.nextScope += 1;
  }
  state.active = state.active.filter((scope) => scope.endOffset >= range.end.index);
  return state.active
    .filter((scope) => scope.startOffset <= range.start.index)
    .sort((left, right) =>
      right.startOffset - left.startOffset || left.endOffset - right.endOffset,
    )[0]?.symbol ?? fileSymbol;
}

function buildReferences(
  path: string,
  fileSymbol: StructuralSymbol,
  scopes: ScopeRecord[],
  candidates: ReferenceCandidate[],
): StructuralReference[] {
  const references: StructuralReference[] = [];
  const state = { nextScope: 0, active: [] as ScopeRecord[] };
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const owner = candidate.kind === "import"
      ? fileSymbol
      : ownerFor(candidate, fileSymbol, scopes, state);
    const key = `${owner.id}|${candidate.kind}|${candidate.targetName}`;
    const ordinal = counts.get(key) ?? 0;
    counts.set(key, ordinal + 1);
    const position = candidate.node.range().start;
    references.push({
      id: `${owner.id}#ref:${candidate.kind}:${candidate.targetName}:${ordinal}`,
      path,
      ownerSymbolId: owner.id,
      kind: candidate.kind,
      targetName: candidate.targetName,
      targetQualifier: candidate.targetQualifier,
      argumentCount: candidate.argumentCount,
      line: position.line + 1,
      column: position.column + 1,
    });
  }
  return references;
}

function parseDiagnostics(path: string, root: SgNode): StructuralDiagnostic[] {
  const issues: SgNode[] = [];
  const visit = (node: SgNode): void => {
    const kind = String(node.kind());
    const missing = kind !== "chunk" &&
      kind !== "comment_content" &&
      node.text().length === 0 &&
      node.range().start.index === node.range().end.index;
    if (kind === "ERROR" || missing) {
      issues.push(node);
      return;
    }
    for (const child of node.children()) visit(child);
  };
  visit(root);
  return issues.map((node) => {
    const position = node.range().start;
    const missing = node.text().length === 0;
    return {
      path,
      code: "lua-parse-error",
      message: missing
        ? `Missing Lua syntax element ${JSON.stringify(String(node.kind()))}.`
        : `Unparsed Lua syntax near ${JSON.stringify(compact(node.text()).slice(0, 160))}.`,
      line: position.line + 1,
      column: position.column + 1,
    };
  });
}

export class LuaLanguageAdapter implements LanguageAdapter {
  readonly id = "lua";
  readonly version = VERSION;
  readonly extensions = EXTENSIONS;

  extract(input: LanguageExtractionInput): FileContribution {
    ensureAstGrepLanguages();
    const root = parse("lua", input.source).root();
    const rootRange = root.range();
    const fileSymbol: StructuralSymbol = {
      id: `${input.path}#file`,
      path: input.path,
      name: basename(input.path),
      qualifiedName: input.path,
      kind: "file",
      span: {
        startLine: 1,
        startColumn: 1,
        endLine: rootRange.end.line + 1,
        endColumn: rootRange.end.column + 1,
      },
      signature: input.path,
      parentId: null,
      callArity: null,
      partial: false,
    };
    const built = buildSymbols(input.path, fileSymbol, collectDeclarations(root));
    return {
      path: input.path,
      hash: input.hash,
      sourceSize: input.size ?? Buffer.byteLength(input.source, "utf8"),
      sourceMtimeMs: input.mtimeMs ?? 0,
      language: this.id,
      extractorVersion: this.version,
      symbols: built.symbols,
      references: buildReferences(
        input.path,
        fileSymbol,
        built.scopes,
        collectReferences(root),
      ),
      diagnostics: parseDiagnostics(input.path, root),
    };
  }
}
