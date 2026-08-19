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

const VERSION = "ast-grep-napi-0.45.1-python-0.0.6-v1";
const EXTENSIONS = new Set([".py", ".pyi"]);

interface DeclarationCandidate {
  node: SgNode;
  name: string;
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

function decoratorNames(node: SgNode): string[] {
  const parent = node.parent();
  if (parent?.kind() !== "decorated_definition") return [];
  return parent.children()
    .filter((child) => child.kind() === "decorator")
    .map((child) => child.text().trim().replace(/^@/, "").split("(")[0]?.trim() ?? "")
    .filter(Boolean);
}

function nearestDefinitionOwner(node: SgNode): "class" | "function" | null {
  for (const ancestor of node.ancestors()) {
    if (ancestor.kind() === "function_definition") return "function";
    if (ancestor.kind() === "class_definition") return "class";
  }
  return null;
}

function parameterArity(
  node: SgNode,
  kind: StructuralSymbolKind,
  decorators: string[],
): StructuralCallArity | null {
  const parameters = safeField(node, "parameters");
  if (parameters === null) return null;
  const values = parameters.children().filter((child) => child.isNamed());
  const variadicKinds = new Set(["list_splat_pattern", "dictionary_splat_pattern"]);
  const fixed = values.filter((child) => !variadicKinds.has(String(child.kind())));
  const optional = fixed.filter(
    (child) => String(child.kind()).includes("default_parameter"),
  ).length;
  const variadic = values.some((child) => variadicKinds.has(String(child.kind())));
  let min = fixed.length - optional;
  let max: number | null = variadic ? null : fixed.length;
  const methodLike = new Set<StructuralSymbolKind>([
    "method",
    "constructor",
    "property",
  ]).has(kind);
  const staticMethod = decorators.some((decorator) => decorator.endsWith("staticmethod"));
  if (methodLike && !staticMethod && fixed.length > 0) {
    min = Math.max(0, min - 1);
    if (max !== null) max = Math.max(0, max - 1);
  }
  return { min, max };
}

function functionKind(node: SgNode, name: string, decorators: string[]): StructuralSymbolKind {
  if (nearestDefinitionOwner(node) !== "class") return "function";
  if (name === "__init__" || name === "__new__") return "constructor";
  if (decorators.some((decorator) =>
    decorator.endsWith("property") ||
    decorator.endsWith("cached_property") ||
    decorator.endsWith(".setter") ||
    decorator.endsWith(".deleter"),
  )) {
    return "property";
  }
  return "method";
}

function collectDeclarations(root: SgNode): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];
  for (const node of nodesOfKind(root, "class_definition")) {
    const name = safeField(node, "name")?.text().trim();
    if (!name) continue;
    const range = node.range();
    candidates.push({
      node,
      name,
      kind: "class",
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
      callArity: null,
    });
  }
  for (const node of nodesOfKind(root, "function_definition")) {
    const name = safeField(node, "name")?.text().trim();
    if (!name) continue;
    const decorators = decoratorNames(node);
    const kind = functionKind(node, name, decorators);
    const range = node.range();
    candidates.push({
      node,
      name,
      kind,
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
      callArity: parameterArity(node, kind, decorators),
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
    const parent = active.at(-1);
    const names = [...(parent?.names ?? []), candidate.name];
    const qualifiedName = names.join(".");
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
      parentId: parent?.symbol.id ?? fileSymbol.id,
      callArity: candidate.callArity,
      partial: false,
    };
    symbols.push(symbol);
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

function simpleName(value: string): string | null {
  return value.replace(/\s+/g, "").match(/([\p{L}_][\p{L}\p{N}_]*)$/u)?.[1] ?? null;
}

function invocationTarget(node: SgNode): { name: string; qualifier: string | null } | null {
  const functionNode = safeField(node, "function");
  if (functionNode === null) return null;
  if (functionNode.kind() === "identifier") {
    return { name: functionNode.text(), qualifier: null };
  }
  if (functionNode.kind() === "attribute") {
    const attribute = safeField(functionNode, "attribute")?.text().trim();
    return attribute ? { name: attribute, qualifier: compact(functionNode.text()) } : null;
  }
  const text = compact(functionNode.text());
  const name = simpleName(text);
  return name === null ? null : { name, qualifier: text };
}

function invocationArgumentCount(node: SgNode): number | null {
  const argumentsNode = safeField(node, "arguments");
  if (argumentsNode === null) return null;
  if (argumentsNode.children().some((child) =>
    child.isNamed() && new Set([
      "list_splat",
      "dictionary_splat",
      "list_splat_pattern",
      "dictionary_splat_pattern",
      "generator_expression",
    ]).has(String(child.kind())),
  )) {
    return null;
  }
  return argumentsNode.children().filter((child) => child.isNamed()).length;
}

function importedName(node: SgNode): string | null {
  if (node.kind() === "aliased_import") return safeField(node, "name")?.text().trim() ?? null;
  if (node.kind() === "dotted_name" || node.kind() === "identifier") return node.text().trim();
  return null;
}

function collectReferences(root: SgNode): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = [];
  for (const node of nodesOfKind(root, "call")) {
    const target = invocationTarget(node);
    if (target === null) continue;
    references.push({
      node,
      kind: "invoke",
      targetName: target.name,
      targetQualifier: target.qualifier,
      argumentCount: invocationArgumentCount(node),
    });
  }
  for (const node of nodesOfKind(root, "class_definition")) {
    const superclasses = safeField(node, "superclasses");
    if (superclasses === null) continue;
    for (const base of superclasses.children().filter((child) =>
      child.isNamed() && child.kind() !== "keyword_argument",
    )) {
      const text = compact(base.text());
      const name = simpleName(text);
      if (name === null) continue;
      references.push({
        node: base,
        kind: "extends",
        targetName: name,
        targetQualifier: text,
        argumentCount: null,
      });
    }
  }
  for (const node of nodesOfKind(root, "import_statement")) {
    for (const imported of node.children().filter((child) => child.isNamed())) {
      const target = importedName(imported);
      if (target === null) continue;
      references.push({
        node: imported,
        kind: "import",
        targetName: target,
        targetQualifier: target,
        argumentCount: null,
      });
    }
  }
  for (const node of nodesOfKind(root, "import_from_statement")) {
    const moduleName = safeField(node, "module_name")?.text().trim();
    if (!moduleName) continue;
    const imported = node.children()
      .filter((child) => child.isNamed())
      .map(importedName)
      .filter((name): name is string => name !== null && name !== moduleName);
    const targets = /^\.+$/.test(moduleName)
      ? imported.map((name) => `${moduleName}${name}`)
      : [moduleName];
    for (const target of targets) {
      references.push({
        node,
        kind: "import",
        targetName: target,
        targetQualifier: target,
        argumentCount: null,
      });
    }
  }
  for (const node of nodesOfKind(root, "decorator")) {
    if (node.children().some((child) => child.kind() === "call")) continue;
    const text = node.text().trim().replace(/^@/, "");
    const name = simpleName(text);
    if (name === null) continue;
    references.push({
      node,
      kind: "invoke",
      targetName: name,
      targetQualifier: text === name ? null : text,
      argumentCount: 1,
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
    const missing = String(node.kind()) !== "module" &&
      node.text().length === 0 &&
      node.range().start.index === node.range().end.index;
    if (String(node.kind()) === "ERROR" || missing) {
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
      code: "python-parse-error",
      message: missing
        ? `Missing Python syntax element ${JSON.stringify(String(node.kind()))}.`
        : `Unparsed Python syntax near ${JSON.stringify(compact(node.text()).slice(0, 160))}.`,
      line: position.line + 1,
      column: position.column + 1,
    };
  });
}

export class PythonLanguageAdapter implements LanguageAdapter {
  readonly id = "python";
  readonly version = VERSION;
  readonly extensions = EXTENSIONS;

  extract(input: LanguageExtractionInput): FileContribution {
    ensureAstGrepLanguages();
    const root = parse("python", input.source).root();
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
