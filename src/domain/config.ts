import { SCHEMA_VERSION, type ProjectConfig } from "./model.js";

const DEFAULT_EXTENSIONS = [
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".lua",
  ".md",
  ".mjs",
  ".php",
  ".proto",
  ".ps1",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
] as const;

const DEFAULT_EXCLUDED_DIRECTORIES = [
  ".git",
  ".semantic-trellis",
  ".idea",
  ".vscode",
  "Library",
  "Temp",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "out",
  "target",
  "vendor",
] as const;

export function normalizeProjectId(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "repository";
}

export function createDefaultConfig(projectName: string): ProjectConfig {
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: normalizeProjectId(projectName),
    source: {
      extensions: [...DEFAULT_EXTENSIONS],
      excludeDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES],
      maxFileBytes: 1_000_000,
    },
    maintenance: {
      impactDepth: 2,
      fullAuditChangeRatio: 0.1,
    },
  };
}
