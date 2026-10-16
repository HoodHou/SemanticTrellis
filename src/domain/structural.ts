export const STRUCTURAL_SCHEMA_VERSION = 8 as const;

export const STRUCTURAL_SYMBOL_KINDS = [
  "file",
  "module",
  "class",
  "interface",
  "struct",
  "record",
  "type",
  "enum",
  "delegate",
  "function",
  "callback",
  "method",
  "constructor",
  "destructor",
  "operator",
  "property",
  "field",
  "event",
  "variable",
  "heading",
  "table",
  "sheet",
] as const;

export type StructuralSymbolKind = (typeof STRUCTURAL_SYMBOL_KINDS)[number];

export const STRUCTURAL_REFERENCE_KINDS = [
  "call",
  "invoke",
  "construct",
  "import",
  "extends",
  "implements",
  "references",
] as const;

export type StructuralReferenceKind = (typeof STRUCTURAL_REFERENCE_KINDS)[number];

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
  callArity: StructuralCallArity | null;
  partial: boolean;
}

export interface StructuralCallArity {
  min: number;
  max: number | null;
}

export interface StructuralReference {
  id: string;
  path: string;
  ownerSymbolId: string;
  kind: StructuralReferenceKind;
  targetName: string;
  targetQualifier: string | null;
  argumentCount: number | null;
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
  sourceSize: number;
  sourceMtimeMs: number;
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
  repositoryRevision: string | null;
  untrackedPaths: string[];
  contributions: Record<string, FileContribution>;
  edges: StructuralEdge[];
  resolution: StructuralResolutionMetrics;
  resolutionByFile: Record<string, StructuralResolutionMetrics>;
  referenceFilesByName: Record<string, string[]>;
  referenceNamesByFile: Record<string, string[]>;
  extractorFingerprint: string;
}

export interface StructuralResolutionMetrics {
  resolvedReferences: number;
  unresolvedReferences: number;
  ambiguousReferences: number;
  unknownReceiverReferences: number;
}

export interface StructuralBuildMetrics {
  discoveryMode: "git" | "filesystem";
  filesDiscovered: number;
  filesSupported: number;
  parsedFiles: number;
  reusedFiles: number;
  removedFiles: number;
  resolvedFiles: number;
  symbols: number;
  references: number;
  diagnostics: number;
  diagnosticFiles: number;
  edges: number;
  resolvedReferences: number;
  unresolvedReferences: number;
  ambiguousReferences: number;
  unknownReceiverReferences: number;
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
  found: boolean;
  focus: StructuralSymbol[];
  symbols: StructuralSymbol[];
  edges: StructuralEdge[];
  ambiguous: boolean;
  suggestions: StructuralSymbolSuggestion[];
}

export interface StructuralSymbolSuggestion {
  symbol: StructuralSymbol;
  score: number;
}

export interface SourceContext {
  startLine: number;
  endLine: number;
  text: string;
  truncated: boolean;
}

export interface StructuralGrepHit {
  line: number;
  column: number;
  matchLength: number;
  text: string;
  context?: SourceContext | undefined;
}

export interface StructuralGrepGroup {
  path: string;
  symbolId: string;
  symbolName: string;
  symbolKind: StructuralSymbolKind;
  inDegree: number;
  curatedNodeIds: string[];
  totalHits: number;
  truncatedHits: number;
  sourceContext?: SourceContext | undefined;
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

export interface StructuralSymbolSearchHit {
  symbol: StructuralSymbol;
  score: number;
  matchedFields: string[];
  inDegree: number;
  curatedNodeIds: string[];
}
