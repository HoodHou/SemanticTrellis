export const PROJECTION_SCHEMA_VERSION = 1 as const;
export const PROJECTION_INDEX_SCHEMA_VERSION = 1 as const;

export type ProjectionFormat = "json" | "markdown";
export type UnsupportedArtifactReason = "unsupported-extension" | "file-too-large";
export type ProjectionHealth =
  | "current"
  | "stale"
  | "invalid"
  | "missing-source"
  | "source-supported";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ProjectionMetadata {
  schemaVersion: typeof PROJECTION_SCHEMA_VERSION;
  kind: "semantic-trellis-projection";
  source: {
    path: string;
    sha256: string;
    mediaType: string;
  };
  producer: {
    tool: string;
    version: string;
  };
  omissions: string[];
  warnings: string[];
}

export interface ParsedProjection {
  format: ProjectionFormat;
  metadata: ProjectionMetadata;
  normalizedContent: string;
}

export interface UnsupportedArtifactRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  extension: string;
  reasons: UnsupportedArtifactReason[];
}

export interface CachedProjectionRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  format: ProjectionFormat;
  metadata: ProjectionMetadata | null;
  error: string | null;
}

export interface ProjectionIndex {
  schemaVersion: typeof PROJECTION_INDEX_SCHEMA_VERSION;
  discoveryMode: "git" | "filesystem";
  repositoryRevision: string | null;
  sources: UnsupportedArtifactRecord[];
  projections: CachedProjectionRecord[];
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

function exactKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  context: string,
): void {
  const accepted = new Set(allowed);
  const unexpected = Object.keys(input).filter((key) => !accepted.has(key));
  if (unexpected.length > 0) {
    throw new Error(`${context} contains unsupported fields: ${unexpected.sort().join(", ")}.`);
  }
}

function stringList(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${context} must be an array.`);
  const values = value.map((item, index) => string(item, `${context}[${index}]`));
  return [...new Set(values)].sort();
}

function repositoryPath(value: unknown, context: string): string {
  const path = string(value, context);
  const segments = path.split("/");
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`${context} must be a normalized repository-relative path.`);
  }
  return path;
}

function sha256(value: unknown, context: string): string {
  const hash = string(value, context);
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`${context} must be a lowercase SHA-256 digest.`);
  }
  return hash;
}

function mediaType(value: unknown, context: string): string {
  const type = string(value, context).toLowerCase();
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) {
    throw new Error(`${context} must be a valid media type.`);
  }
  return type;
}

function metadata(value: unknown, context: string, allowContent: boolean): ProjectionMetadata {
  const input = record(value, context);
  exactKeys(
    input,
    allowContent
      ? ["schemaVersion", "kind", "source", "producer", "omissions", "warnings", "content"]
      : ["schemaVersion", "kind", "source", "producer", "omissions", "warnings"],
    context,
  );
  if (input.schemaVersion !== PROJECTION_SCHEMA_VERSION) {
    throw new Error(`${context}.schemaVersion must be ${PROJECTION_SCHEMA_VERSION}.`);
  }
  if (input.kind !== "semantic-trellis-projection") {
    throw new Error(`${context}.kind must be "semantic-trellis-projection".`);
  }
  const source = record(input.source, `${context}.source`);
  exactKeys(source, ["path", "sha256", "mediaType"], `${context}.source`);
  const producer = record(input.producer, `${context}.producer`);
  exactKeys(producer, ["tool", "version"], `${context}.producer`);
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    kind: "semantic-trellis-projection",
    source: {
      path: repositoryPath(source.path, `${context}.source.path`),
      sha256: sha256(source.sha256, `${context}.source.sha256`),
      mediaType: mediaType(source.mediaType, `${context}.source.mediaType`),
    },
    producer: {
      tool: string(producer.tool, `${context}.producer.tool`),
      version: string(producer.version, `${context}.producer.version`),
    },
    omissions: stringList(input.omissions, `${context}.omissions`),
    warnings: stringList(input.warnings, `${context}.warnings`),
  };
}

function stableJsonValue(value: unknown, context: string): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${context} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => stableJsonValue(item, `${context}[${index}]`));
  }
  if (typeof value === "object") {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, stableJsonValue(input[key], `${context}.${key}`)]),
    );
  }
  throw new Error(`${context} must contain only JSON values.`);
}

function metadataValue(value: ProjectionMetadata): Record<string, unknown> {
  return {
    schemaVersion: value.schemaVersion,
    kind: value.kind,
    source: {
      path: value.source.path,
      sha256: value.source.sha256,
      mediaType: value.source.mediaType,
    },
    producer: {
      tool: value.producer.tool,
      version: value.producer.version,
    },
    omissions: value.omissions,
    warnings: value.warnings,
  };
}

export function projectionFormat(path: string): ProjectionFormat | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".strellis.json")) return "json";
  if (lower.endsWith(".strellis.md")) return "markdown";
  return null;
}

export function isProjectionPath(path: string): boolean {
  return projectionFormat(path) !== null;
}

export function projectionSourcePath(path: string): string | null {
  const format = projectionFormat(path);
  if (format === null) return null;
  return path.slice(0, -`.strellis.${format === "json" ? "json" : "md"}`.length);
}

export function expectedProjectionPath(sourcePath: string, format: ProjectionFormat): string {
  return `${sourcePath}.strellis.${format === "json" ? "json" : "md"}`;
}

export function parseProjectionDocument(path: string, raw: string): ParsedProjection {
  const format = projectionFormat(path);
  if (format === null) {
    throw new Error("Projection path must end in .strellis.json or .strellis.md.");
  }
  const normalizedRaw = raw.replace(/\r\n?/g, "\n");
  let parsedMetadata: ProjectionMetadata;
  let normalizedContent: string;
  if (format === "json") {
    let value: unknown;
    try {
      value = JSON.parse(normalizedRaw) as unknown;
    } catch (error) {
      throw new Error(`Projection JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const input = record(value, "Projection");
    parsedMetadata = metadata(input, "Projection", true);
    if (!("content" in input)) throw new Error("Projection.content is required.");
    const content = stableJsonValue(input.content, "Projection.content");
    if (content === null || typeof content !== "object") {
      throw new Error("Projection.content must be a JSON object or array.");
    }
    normalizedContent = `${JSON.stringify({
      ...metadataValue(parsedMetadata),
      content,
    }, null, 2)}\n`;
  } else {
    const prefix = "<!-- semantic-trellis-projection\n";
    const suffix = "\n-->";
    if (!normalizedRaw.startsWith(prefix)) {
      throw new Error("Markdown projection must start with the semantic-trellis-projection metadata block.");
    }
    const metadataEnd = normalizedRaw.indexOf(suffix, prefix.length);
    if (metadataEnd < 0) throw new Error("Markdown projection metadata block is not closed.");
    let value: unknown;
    try {
      value = JSON.parse(normalizedRaw.slice(prefix.length, metadataEnd)) as unknown;
    } catch (error) {
      throw new Error(`Markdown projection metadata is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    parsedMetadata = metadata(value, "Projection metadata", false);
    const body = normalizedRaw.slice(metadataEnd + suffix.length).replace(/^\n/, "").trimEnd();
    if (!body.trim()) throw new Error("Markdown projection body must not be empty.");
    normalizedContent = `${prefix}${JSON.stringify(metadataValue(parsedMetadata), null, 2)}${suffix}\n${body}\n`;
  }

  const expectedPath = expectedProjectionPath(parsedMetadata.source.path, format);
  if (path !== expectedPath) {
    throw new Error(`Projection path must be ${expectedPath}.`);
  }
  if (isProjectionPath(parsedMetadata.source.path)) {
    throw new Error("A projection cannot use another projection as its source.");
  }
  return { format, metadata: parsedMetadata, normalizedContent };
}
