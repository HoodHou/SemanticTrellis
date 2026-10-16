export const SCHEMA_VERSION = 1 as const;

export type SemanticNodeKind =
  | "system"
  | "subsystem"
  | "component"
  | "concept"
  | "invariant"
  | "file"
  | "external";

export type ApprovalStatus = "proposed" | "approved" | "deprecated";

export type SemanticRelation =
  | "contains"
  | "depends-on"
  | "calls"
  | "produces"
  | "consumes"
  | "implements"
  | "extends"
  | "configures"
  | "validates"
  | "documents"
  | "related-to";

export interface SourceReference {
  path: string;
  role: "primary" | "supporting";
}

export interface SemanticNode {
  id: string;
  name: string;
  kind: SemanticNodeKind;
  summary: string;
  sources: SourceReference[];
  tags: string[];
  status: ApprovalStatus;
  locked: boolean;
}

export interface SemanticEdge {
  id: string;
  from: string;
  to: string;
  relation: SemanticRelation;
  description: string;
  status: ApprovalStatus;
}

export interface CuratedGraph {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  nodes: SemanticNode[];
  edges: SemanticEdge[];
}

export interface SourcePolicy {
  extensions: string[];
  excludeDirectories: string[];
  maxFileBytes: number;
}

export interface MaintenancePolicy {
  impactDepth: number;
  fullAuditChangeRatio: number;
}

export interface ProjectConfig {
  schemaVersion: typeof SCHEMA_VERSION;
  projectId: string;
  source: SourcePolicy;
  maintenance: MaintenancePolicy;
}

export interface FileRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs?: number | undefined;
}

export interface RepositorySnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  files: FileRecord[];
}

export type FileChangeKind = "added" | "changed" | "removed";

export interface FileChange {
  kind: FileChangeKind;
  path: string;
  before: FileRecord | null;
  after: FileRecord | null;
}

export type ReviewReason =
  | "initial-classification"
  | "source-added"
  | "source-changed"
  | "source-removed";

export type StructuralReviewNature =
  | "implementation-only"
  | "symbol-signature-changed"
  | "cross-node-reference-changed"
  | "file-moved"
  | "source-added"
  | "source-removed";

export interface ReviewSymbolChange {
  change: "added" | "removed" | "signature-changed";
  name: string;
  qualifiedName: string;
  kind: string;
  beforeSignature: string | null;
  afterSignature: string | null;
}

export interface ReviewReferenceChange {
  change: "added" | "removed";
  kind: string;
  ownerQualifiedName: string;
  targetName: string;
  targetPath: string | null;
}

export interface ReviewStructuralDelta {
  nature: StructuralReviewNature;
  movedFrom: string | null;
  movedTo: string | null;
  symbolChanges: ReviewSymbolChange[];
  referenceChanges: ReviewReferenceChange[];
}

export interface ReviewItem {
  id: string;
  path: string;
  changeKind: FileChangeKind;
  reason: ReviewReason;
  beforeHash: string | null;
  afterHash: string | null;
  relatedNodeIds: string[];
  structuralDelta: ReviewStructuralDelta | null;
}

export interface ReviewQueue {
  schemaVersion: typeof SCHEMA_VERSION;
  items: ReviewItem[];
}

export interface UpsertNodeOperation {
  op: "upsert-node";
  node: SemanticNode;
  overrideLocked?: boolean | undefined;
}

export interface RemoveNodeOperation {
  op: "remove-node";
  nodeId: string;
  overrideLocked?: boolean | undefined;
}

export interface UpsertEdgeOperation {
  op: "upsert-edge";
  edge: SemanticEdge;
}

export interface RemoveEdgeOperation {
  op: "remove-edge";
  edgeId: string;
}

export interface MarkReviewedOperation {
  op: "mark-reviewed";
  paths: string[];
}

export type GraphPatchOperation =
  | UpsertNodeOperation
  | RemoveNodeOperation
  | UpsertEdgeOperation
  | RemoveEdgeOperation
  | MarkReviewedOperation;

export interface GraphPatch {
  schemaVersion: typeof SCHEMA_VERSION;
  operations: GraphPatchOperation[];
}

export type AuditSeverity = "error" | "warning" | "info";

export interface AuditIssue {
  severity: AuditSeverity;
  code: string;
  message: string;
  subject: string;
}

export interface GraphAudit {
  issues: AuditIssue[];
  errors: number;
  warnings: number;
  information: number;
}
