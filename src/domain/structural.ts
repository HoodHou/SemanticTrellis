export const STRUCTURAL_SCHEMA_VERSION = 2 as const;

export type StructuralSymbolKind =
  | "file"
  | "module"
  | "class"
  | "interface"
  | "struct"
  | "record"
  | "type"
  | "enum"
  | "delegate"
  | "function"
  | "method"
  | "constructor"
  | "destructor"
  | "operator"
  | "property"
  | "field"
  | "event"
  | "variable";

export type StructuralReferenceKind =
  | "call"
  | "construct"
  | "import"
  | "extends"
  | "implements";

export interface SourceSpan {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface StructuralSymbol {
  id: string;
  path: string;
  name: string;
  qualifiedName: string;
  kind: StructuralSymbolKind;
  span: SourceSpan;
  signature: string;
  parentId: string | null;
}

export interface StructuralReference {
  id: string;
  path: string;
  ownerSymbolId: string;
  kind: StructuralReferenceKind;
  targetName: string;
  targetQualifier: string | null;
  line: number;
  column: number;
}

export interface StructuralDiagnostic {
  path: string;
  code: string;
  message: string;
  line: number;
  column: number;
}

export interface FileContribution {
  path: string;
  hash: string;
  language: string;
  extractorVersion: string;
  symbols: StructuralSymbol[];
  references: StructuralReference[];
  diagnostics: StructuralDiagnostic[];
}

export interface StructuralEdge {
  id: string;
  from: string;
  to: string;
  kind: StructuralReferenceKind;
  referenceId: string;
}

export interface StructuralIndex {
  schemaVersion: typeof STRUCTURAL_SCHEMA_VERSION;
  discoveryMode: "git" | "filesystem";
  contributions: Record<string, FileContribution>;
  edges: StructuralEdge[];
}

export interface StructuralBuildMetrics {
  discoveryMode: "git" | "filesystem";
  filesDiscovered: number;
  filesSupported: number;
  parsedFiles: number;
  reusedFiles: number;
  removedFiles: number;
  symbols: number;
  references: number;
  diagnostics: number;
  diagnosticFiles: number;
  edges: number;
  durationMs: number;
}

export interface StructuralBuildResult {
  index: StructuralIndex;
  metrics: StructuralBuildMetrics;
}

export type TraceDirection = "incoming" | "outgoing" | "both";

export interface StructuralTrace {
  query: string;
  direction: TraceDirection;
  depth: number;
  focus: StructuralSymbol[];
  symbols: StructuralSymbol[];
  edges: StructuralEdge[];
  ambiguous: boolean;
}

export interface StructuralGrepHit {
  line: number;
  text: string;
}

export interface StructuralGrepGroup {
  path: string;
  symbolId: string;
  symbolName: string;
  symbolKind: StructuralSymbolKind;
  inDegree: number;
  curatedNodeIds: string[];
  hits: StructuralGrepHit[];
}

export interface StructuralGrepResult {
  pattern: string;
  filesSearched: number;
  totalHits: number;
  groups: StructuralGrepGroup[];
  truncatedHits: number;
  symbolAttributionRate: number;
  curatedAttributionRate: number;
  queryDurationMs: number;
}
