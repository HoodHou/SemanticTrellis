import { basename } from "node:path";
import { parse, type SgNode } from "@ast-grep/napi";
import type {
  FileContribution,
  SourceSpan,
  StructuralDiagnostic,
  StructuralReference,
  StructuralReferenceKind,
  StructuralSymbol,
  StructuralSymbolKind,
} from "../../domain/structural.js";
import type { LanguageAdapter, LanguageExtractionInput } from "../../ports/language-adapter.js";
import { ensureAstGrepLanguages } from "../ast-grep-runtime.js";

const VERSION = "ast-grep-napi-0.45.1-csharp-0.0.6-v2";
const EXTENSIONS = new Set([".cs"]);

interface DeclarationCandidate {
  node: SgNode;
  signatureNode: SgNode;
  name: string;
  kind: StructuralSymbolKind;
  opensScope: boolean;
  startOffset: number;
  endOffset: number;
}

interface ScopeRecord {
  startOffset: number;
  endOffset: number;
  names: string[];
  symbol: StructuralSymbol;
}

interface ReferenceCandidate {
  node: SgNode;
  kind: "invocation" | "construction" | "using" | "base";
  baseIndex?: number;
}

const DECLARATIONS: ReadonlyArray<{
  astKind: string;
  symbolKind: StructuralSymbolKind;
  opensScope: boolean;
  fixedName?: string;
}> = [
  { astKind: "namespace_declaration", symbolKind: "module", opensScope: true },
  { astKind: "file_scoped_namespace_declaration", symbolKind: "module", opensScope: true },
  { astKind: "class_declaration", symbolKind: "class", opensScope: true },
  { astKind: "interface_declaration", symbolKind: "interface", opensScope: true },
  { astKind: "struct_declaration", symbolKind: "struct", opensScope: true },
  { astKind: "record_declaration", symbolKind: "record", opensScope: true },
  { astKind: "enum_declaration", symbolKind: "enum", opensScope: true },
  { astKind: "delegate_declaration", symbolKind: "delegate", opensScope: false },
  { astKind: "method_declaration", symbolKind: "method", opensScope: true },
  { astKind: "local_function_statement", symbolKind: "function", opensScope: true },
  { astKind: "constructor_declaration", symbolKind: "constructor", opensScope: true, fixedName: "constructor" },
  { astKind: "destructor_declaration", symbolKind: "destructor", opensScope: true, fixedName: "destructor" },
  { astKind: "property_declaration", symbolKind: "property", opensScope: true },
  { astKind: "event_declaration", symbolKind: "event", opensScope: true },
  { astKind: "indexer_declaration", symbolKind: "property", opensScope: true, fixedName: "this[]" },
];

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

function signatureOf(node: SgNode): string {
  const text = compact(node.text());
  const bodyStart = text.search(/=>|\{/);
  const header = bodyStart < 0
    ? text
    : text.slice(0, bodyStart + (text.startsWith("=>", bodyStart) ? 2 : 1));
  return header.slice(0, 320);
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

function nameField(node: SgNode): string | null {
  const name = safeField(node, "name")?.text().trim();
  return name ? name.replace(/^@/, "") : null;
}

function operatorName(node: SgNode): string {
  const operator = safeField(node, "operator")?.text().trim() ?? "unknown";
  return `operator ${operator}`;
}

function conversionOperatorName(node: SgNode): string {
  const mode = /\bimplicit\b/.test(node.text()) ? "implicit" : "explicit";
  const target = safeField(node, "type")?.text().trim() ?? "unknown";
  return `${mode} operator ${target}`;
}

function collectDeclarations(root: SgNode): DeclarationCandidate[] {
  const candidates: DeclarationCandidate[] = [];
  for (const declaration of DECLARATIONS) {
    for (const node of nodesOfKind(root, declaration.astKind)) {
      const name = declaration.fixedName ?? nameField(node);
      if (name === null) continue;
      const range = node.range();
      candidates.push({
        node,
        signatureNode: node,
        name,
        kind: declaration.symbolKind,
        opensScope: declaration.opensScope,
        startOffset: range.start.index,
        endOffset: range.end.index,
      });
    }
  }

  for (const node of nodesOfKind(root, "operator_declaration")) {
    const range = node.range();
    candidates.push({
      node,
      signatureNode: node,
      name: operatorName(node),
      kind: "operator",
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
    });
  }
  for (const node of nodesOfKind(root, "conversion_operator_declaration")) {
    const range = node.range();
    candidates.push({
      node,
      signatureNode: node,
      name: conversionOperatorName(node),
      kind: "operator",
      opensScope: true,
      startOffset: range.start.index,
      endOffset: range.end.index,
    });
  }

  for (const [astKind, symbolKind] of [
    ["field_declaration", "field"],
    ["event_field_declaration", "event"],
  ] as const) {
    for (const declaration of nodesOfKind(root, astKind)) {
      for (const variable of nodesOfKind(declaration, "variable_declarator")) {
        const owner = variable.ancestors().find((ancestor) => ancestor.kind() === astKind);
        if (owner?.id() !== declaration.id()) continue;
        const name = nameField(variable);
        if (name === null) continue;
        const range = variable.range();
        candidates.push({
          node: variable,
          signatureNode: declaration,
          name,
          kind: symbolKind,
          opensScope: true,
          startOffset: range.start.index,
          endOffset: range.end.index,
        });
      }
    }
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
      signature: signatureOf(candidate.signatureNode),
      parentId: parent?.symbol.id ?? fileSymbol.id,
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

function stripGenericArguments(value: string): string {
  let current = value;
  let previous = "";
  while (current !== previous) {
    previous = current;
    current = current.replace(/<[^<>]*>/g, "");
  }
  return current;
}

function normalizedQualifier(value: string): string {
  return stripGenericArguments(value)
    .replace(/\?\./g, ".")
    .replace(/::/g, ".")
    .replace(/\s+/g, "")
    .replace(/^global\./, "")
    .replace(/^@/, "");
}

function simpleNameFromText(value: string): string | null {
  const normalized = normalizedQualifier(value)
    .replace(/\[.*\]$/, "")
    .replace(/\?$/, "");
  const match = normalized.match(/@?([\p{L}_][\p{L}\p{N}_]*)$/u);
  return match?.[1] ?? null;
}

function invocationTarget(node: SgNode): { name: string; qualifier: string | null } | null {
  const functionNode = safeField(node, "function");
  if (functionNode === null) return null;
  const kind = functionNode.kind();
  if (kind === "identifier" || kind === "generic_name") {
    const name = simpleNameFromText(functionNode.text());
    return name === null ? null : { name, qualifier: null };
  }
  if (kind === "member_access_expression" || kind === "member_binding_expression") {
    const nameNode = safeField(functionNode, "name");
    const name = simpleNameFromText(nameNode?.text() ?? functionNode.text());
    return name === null
      ? null
      : { name, qualifier: normalizedQualifier(functionNode.text()) };
  }
  return null;
}

function collectReferences(root: SgNode): ReferenceCandidate[] {
  const references: ReferenceCandidate[] = [];
  for (const node of nodesOfKind(root, "invocation_expression")) {
    references.push({ node, kind: "invocation" });
  }
  for (const node of nodesOfKind(root, "object_creation_expression")) {
    references.push({ node, kind: "construction" });
  }
  for (const node of nodesOfKind(root, "using_directive")) {
    references.push({ node, kind: "using" });
  }
  for (const list of nodesOfKind(root, "base_list")) {
    const types = list.children().filter((child) => child.isNamed());
    for (let index = 0; index < types.length; index += 1) {
      const node = types[index];
      if (node !== undefined) references.push({ node, kind: "base", baseIndex: index });
    }
  }
  return references.sort((left, right) =>
    left.node.range().start.index - right.node.range().start.index,
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

function referenceRecord(
  path: string,
  ownerSymbolId: string,
  node: SgNode,
  kind: StructuralReferenceKind,
  targetName: string,
  targetQualifier: string | null,
  ordinal: number,
): StructuralReference {
  const position = node.range().start;
  const line = position.line + 1;
  const column = position.column + 1;
  return {
    id: `${ownerSymbolId}#ref:${kind}:${targetName}:${ordinal}`,
    path,
    ownerSymbolId,
    kind,
    targetName,
    targetQualifier,
    line,
    column,
  };
}

function usingTarget(node: SgNode): string | null {
  const alias = safeField(node, "name");
  const children = node.children().filter((child) => child.isNamed());
  const candidates = alias === null
    ? children
    : children.filter((child) => child.id() !== alias.id());
  return candidates.at(-1)?.text().trim() ?? null;
}

function baseReferenceKind(owner: StructuralSymbol, index: number): StructuralReferenceKind {
  if (owner.kind === "interface") return "extends";
  if (owner.kind === "struct") return "implements";
  return index === 0 ? "extends" : "implements";
}

function buildReferences(
  path: string,
  fileSymbol: StructuralSymbol,
  scopes: ScopeRecord[],
  candidates: ReferenceCandidate[],
): StructuralReference[] {
  const references: StructuralReference[] = [];
  const state = { nextScope: 0, active: [] as ScopeRecord[] };
  const referenceCounts = new Map<string, number>();
  const ordinal = (
    ownerSymbolId: string,
    kind: StructuralReferenceKind,
    targetName: string,
  ): number => {
    const key = `${ownerSymbolId}|${kind}|${targetName}`;
    const value = referenceCounts.get(key) ?? 0;
    referenceCounts.set(key, value + 1);
    return value;
  };
  for (const candidate of candidates) {
    const owner = ownerFor(candidate, fileSymbol, scopes, state);
    if (candidate.kind === "invocation") {
      const target = invocationTarget(candidate.node);
      if (target === null) continue;
      references.push(referenceRecord(
        path,
        owner.id,
        candidate.node,
        "call",
        target.name,
        target.qualifier,
        ordinal(owner.id, "call", target.name),
      ));
      continue;
    }
    if (candidate.kind === "construction") {
      const type = safeField(candidate.node, "type")?.text().trim();
      const name = type === undefined ? null : simpleNameFromText(type);
      if (type === undefined || name === null) continue;
      references.push(referenceRecord(
        path,
        owner.id,
        candidate.node,
        "construct",
        name,
        normalizedQualifier(type),
        ordinal(owner.id, "construct", name),
      ));
      continue;
    }
    if (candidate.kind === "using") {
      const target = usingTarget(candidate.node);
      if (target === null) continue;
      const normalized = normalizedQualifier(target);
      references.push(referenceRecord(
        path,
        fileSymbol.id,
        candidate.node,
        "import",
        simpleNameFromText(normalized) ?? normalized,
        normalized,
        ordinal(fileSymbol.id, "import", simpleNameFromText(normalized) ?? normalized),
      ));
      continue;
    }
    const text = candidate.node.text().trim();
    const name = simpleNameFromText(text);
    if (name === null) continue;
    references.push(referenceRecord(
      path,
      owner.id,
      candidate.node,
      baseReferenceKind(owner, candidate.baseIndex ?? 0),
      name,
      normalizedQualifier(text),
      ordinal(
        owner.id,
        baseReferenceKind(owner, candidate.baseIndex ?? 0),
        name,
      ),
    ));
  }
  return references;
}

function parseDiagnostics(path: string, root: SgNode): StructuralDiagnostic[] {
  return nodesOfKind(root, "ERROR").map((node) => {
    const position = node.range().start;
    return {
      path,
      code: "csharp-parse-error",
      message: `Unparsed C# syntax near ${JSON.stringify(compact(node.text()).slice(0, 160))}.`,
      line: position.line + 1,
      column: position.column + 1,
    };
  });
}

export class CSharpLanguageAdapter implements LanguageAdapter {
  readonly id = "csharp";
  readonly version = VERSION;
  readonly extensions = EXTENSIONS;

  extract(input: LanguageExtractionInput): FileContribution {
    ensureAstGrepLanguages();
    const root = parse("csharp", input.source).root();
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
