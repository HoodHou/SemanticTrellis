import { basename, extname } from "node:path";
import * as ts from "typescript-compiler";
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

const VERSION = `typescript-compiler-${ts.version}-v2`;
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

interface Scope {
  names: string[];
  ownerSymbolId: string;
}

interface SymbolDescriptor {
  name: string;
  kind: StructuralSymbolKind;
  opensScope: boolean;
}

function scriptKind(path: string): ts.ScriptKind {
  switch (extname(path).toLowerCase()) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

function nameText(name: ts.DeclarationName | ts.BindingName | undefined, file: ts.SourceFile): string | null {
  if (name === undefined) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(file).replace(/\s+/g, " ").trim();
}

function isModuleVariable(node: ts.VariableDeclaration): boolean {
  const list = node.parent;
  const statement = list.parent;
  return ts.isVariableStatement(statement) &&
    (ts.isSourceFile(statement.parent) || ts.isModuleBlock(statement.parent));
}

function callbackDescriptor(
  node: ts.ArrowFunction | ts.FunctionExpression,
  file: ts.SourceFile,
): SymbolDescriptor | null {
  const call = node.parent;
  if (!ts.isCallExpression(call)) return null;
  const argumentIndex = call.arguments.indexOf(node);
  if (argumentIndex < 0) return null;
  const calleeText = call.expression.getText(file).replace(/\s+/g, " ").trim();
  const callee = calleeText.split(".").at(-1) ?? calleeText;
  const firstArgument = call.arguments[0];
  const label = firstArgument !== undefined &&
    (ts.isStringLiteral(firstArgument) || ts.isNoSubstitutionTemplateLiteral(firstArgument))
    ? firstArgument.text.replace(/\s+/g, " ").trim().slice(0, 120)
    : null;
  return {
    name: label === null
      ? `${callee} callback ${argumentIndex + 1}`
      : `${callee} ${JSON.stringify(label)}`,
    kind: "callback",
    opensScope: true,
  };
}

function descriptor(node: ts.Node, file: ts.SourceFile): SymbolDescriptor | null {
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    const name = nameText(node.name, file);
    return name === null ? null : { name, kind: "class", opensScope: true };
  }
  if (ts.isInterfaceDeclaration(node)) {
    return { name: node.name.text, kind: "interface", opensScope: true };
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return { name: node.name.text, kind: "type", opensScope: false };
  }
  if (ts.isEnumDeclaration(node)) {
    return { name: node.name.text, kind: "enum", opensScope: true };
  }
  if (ts.isModuleDeclaration(node)) {
    return { name: node.name.getText(file).replace(/["']/g, ""), kind: "module", opensScope: true };
  }
  if (ts.isFunctionDeclaration(node)) {
    const name = nameText(node.name, file);
    return name === null ? null : { name, kind: "function", opensScope: true };
  }
  if (ts.isFunctionExpression(node) && node.name !== undefined) {
    return { name: node.name.text, kind: "function", opensScope: true };
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const callback = callbackDescriptor(node, file);
    if (callback !== null) return callback;
  }
  if (
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    const name = nameText(node.name, file);
    return name === null ? null : { name, kind: "method", opensScope: true };
  }
  if (ts.isConstructorDeclaration(node)) {
    return { name: "constructor", kind: "constructor", opensScope: true };
  }
  if (ts.isVariableDeclaration(node) && isModuleVariable(node)) {
    const name = nameText(node.name, file);
    if (name === null) return null;
    const functionLike = node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
    return { name, kind: functionLike ? "function" : "variable", opensScope: functionLike };
  }
  return null;
}

function spanOf(node: ts.Node, file: ts.SourceFile): SourceSpan {
  const start = file.getLineAndCharacterOfPosition(node.getStart(file));
  const end = file.getLineAndCharacterOfPosition(node.getEnd());
  return {
    startLine: start.line + 1,
    startColumn: start.character + 1,
    endLine: end.line + 1,
    endColumn: end.character + 1,
  };
}

function signatureOf(node: ts.Node, file: ts.SourceFile): string {
  const text = node.getText(file);
  const bodyStart = text.search(/=>|\{/);
  const header = bodyStart >= 0 ? text.slice(0, bodyStart + (text.startsWith("=>", bodyStart) ? 2 : 1)) : text;
  return header.replace(/\s+/g, " ").trim().slice(0, 320);
}

function referencePosition(node: ts.Node, file: ts.SourceFile): { line: number; column: number } {
  const position = file.getLineAndCharacterOfPosition(node.getStart(file));
  return { line: position.line + 1, column: position.character + 1 };
}

function parseDiagnostics(path: string, file: ts.SourceFile): StructuralDiagnostic[] {
  const diagnostics = (file as ts.SourceFile & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics ?? [];
  return diagnostics.map((diagnostic) => {
    const position = diagnostic.start === undefined
      ? { line: 0, character: 0 }
      : file.getLineAndCharacterOfPosition(diagnostic.start);
    return {
      path,
      code: `typescript-${diagnostic.code}`,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: position.line + 1,
      column: position.character + 1,
    };
  });
}

function callTarget(expression: ts.Expression, file: ts.SourceFile): { name: string; qualifier: string | null } {
  if (ts.isIdentifier(expression)) return { name: expression.text, qualifier: null };
  if (ts.isPropertyAccessExpression(expression)) {
    return { name: expression.name.text, qualifier: expression.getText(file) };
  }
  const text = expression.getText(file).replace(/\s+/g, " ").trim();
  return { name: text, qualifier: text };
}

function reference(
  path: string,
  file: ts.SourceFile,
  node: ts.Node,
  ownerSymbolId: string,
  kind: StructuralReferenceKind,
  targetName: string,
  targetQualifier: string | null,
  ordinal: number,
): StructuralReference {
  const position = referencePosition(node, file);
  return {
    id: `${ownerSymbolId}#ref:${kind}:${targetName}:${ordinal}`,
    path,
    ownerSymbolId,
    kind,
    targetName,
    targetQualifier,
    ...position,
  };
}

export class TypeScriptLanguageAdapter implements LanguageAdapter {
  readonly id = "typescript";
  readonly version = VERSION;
  readonly extensions = EXTENSIONS;

  extract(input: LanguageExtractionInput): FileContribution {
    const file = ts.createSourceFile(
      input.path,
      input.source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(input.path),
    );
    const lineCount = file.getLineAndCharacterOfPosition(file.getEnd()).line + 1;
    const fileSymbol: StructuralSymbol = {
      id: `${input.path}#file`,
      path: input.path,
      name: basename(input.path),
      qualifiedName: input.path,
      kind: "file",
      span: { startLine: 1, startColumn: 1, endLine: lineCount, endColumn: 1 },
      signature: input.path,
      parentId: null,
    };
    const symbols: StructuralSymbol[] = [fileSymbol];
    const references: StructuralReference[] = [];
    const duplicateCounts = new Map<string, number>();
    const referenceCounts = new Map<string, number>();
    const referenceOrdinal = (
      ownerSymbolId: string,
      kind: StructuralReferenceKind,
      targetName: string,
    ): number => {
      const key = `${ownerSymbolId}|${kind}|${targetName}`;
      const ordinal = referenceCounts.get(key) ?? 0;
      referenceCounts.set(key, ordinal + 1);
      return ordinal;
    };

    const visit = (node: ts.Node, scope: Scope): void => {
      const found = descriptor(node, file);
      let childScope = scope;
      if (found !== null) {
        const qualifiedName = [...scope.names, found.name].join(".");
        const duplicateKey = `${found.kind}:${qualifiedName}`;
        const ordinal = (duplicateCounts.get(duplicateKey) ?? 0) + 1;
        duplicateCounts.set(duplicateKey, ordinal);
        const suffix = ordinal === 1 ? "" : `~${ordinal}`;
        const id = `${input.path}#${found.kind}:${qualifiedName}${suffix}`;
        symbols.push({
          id,
          path: input.path,
          name: found.name,
          qualifiedName,
          kind: found.kind,
          span: spanOf(node, file),
          signature: signatureOf(node, file),
          parentId: scope.ownerSymbolId,
        });
        if (found.opensScope) {
          childScope = { names: [...scope.names, found.name], ownerSymbolId: id };
        }
      }

      if (ts.isCallExpression(node)) {
        const target = callTarget(node.expression, file);
        references.push(reference(
          input.path,
          file,
          node.expression,
          childScope.ownerSymbolId,
          "call",
          target.name,
          target.qualifier,
          referenceOrdinal(childScope.ownerSymbolId, "call", target.name),
        ));
      } else if (ts.isNewExpression(node)) {
        const target = callTarget(node.expression, file);
        references.push(reference(
          input.path,
          file,
          node.expression,
          childScope.ownerSymbolId,
          "construct",
          target.name,
          target.qualifier,
          referenceOrdinal(childScope.ownerSymbolId, "construct", target.name),
        ));
      } else if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        references.push(reference(
          input.path,
          file,
          node.moduleSpecifier,
          fileSymbol.id,
          "import",
          node.moduleSpecifier.text,
          node.moduleSpecifier.text,
          referenceOrdinal(fileSymbol.id, "import", node.moduleSpecifier.text),
        ));
      } else if (ts.isHeritageClause(node)) {
        const kind: StructuralReferenceKind = node.token === ts.SyntaxKind.ExtendsKeyword
          ? "extends"
          : "implements";
        for (const type of node.types) {
          const target = callTarget(type.expression, file);
          references.push(reference(
            input.path,
            file,
            type.expression,
            childScope.ownerSymbolId,
            kind,
            target.name,
            target.qualifier,
            referenceOrdinal(childScope.ownerSymbolId, kind, target.name),
          ));
        }
      }

      ts.forEachChild(node, (child) => visit(child, childScope));
    };

    visit(file, { names: [], ownerSymbolId: fileSymbol.id });
    return {
      path: input.path,
      hash: input.hash,
      sourceSize: input.size ?? Buffer.byteLength(input.source, "utf8"),
      sourceMtimeMs: input.mtimeMs ?? 0,
      language: this.id,
      extractorVersion: this.version,
      symbols,
      references,
      diagnostics: parseDiagnostics(input.path, file),
    };
  }
}
