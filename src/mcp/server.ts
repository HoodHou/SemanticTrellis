import { McpServer } from "@modelcontextprotocol/server";
import { resolve } from "node:path";
import * as z from "zod/v4";
import {
  applyValidatedCurationPatch,
  askProject,
  auditProject,
  buildStructuralIndex,
  finishAgentBootstrap,
  getAgentBootstrapStatus,
  getBootstrapCurationContext,
  getFileSymbols,
  getNextBootstrapRollups,
  getNextBootstrapSourceBatch,
  getProjectionStatus,
  buildReviewContext,
  grepStructure,
  listUnsupportedArtifacts,
  previewAgentBootstrap,
  projectStatus,
  registerArtifactProjection,
  searchProjectSymbols,
  startAgentBootstrap,
  submitBootstrapChunkSummaries,
  submitBootstrapFileSummaries,
  syncProject,
  traceProjectStructure,
  validateArtifactProjection,
  validateCurationPatch,
} from "../application/index.js";
import { graphNeighborhood, searchGraph } from "../domain/query.js";
import { STRUCTURAL_SYMBOL_KINDS } from "../domain/structural.js";
import { loadGraph, loadReviewQueue } from "../infrastructure/project-store.js";
import { VERSION } from "../version.js";
import {
  applyOutputSchema,
  agentBootstrapStartOutputSchema,
  agentBootstrapPreviewOutputSchema,
  agentBootstrapStatusSchema,
  asGraphPatch,
  auditOutputSchema,
  chunkSummarySubmissionSchema,
  fileSymbolsOutputSchema,
  fileSemanticSummarySchema,
  graphOutputSchema,
  graphPatchSchema,
  projectionRegistrationOutputSchema,
  projectionStatusOutputSchema,
  projectionValidationOutputSchema,
  reviewContextOutputSchema,
  reviewQueueOutputSchema,
  searchOutputSchema,
  statusOutputSchema,
  structuralBuildMetricsSchema,
  structuralAskOutputSchema,
  structuralGrepOutputSchema,
  structuralSymbolSearchOutputSchema,
  structuralTraceOutputSchema,
  syncOutputSchema,
  unsupportedArtifactListSchema,
  validationOutputSchema,
} from "./schemas.js";

const INSTRUCTIONS = [
  "SemanticTrellis serves one fixed repository. Structural read tools repair ordinary source deltas automatically; use ask for one-call natural-language discovery with bounded source bodies, up to two callee cruxes, and matching curated-node summaries. Use symbol_search for ranked metadata, and grep/trace for exact or exhaustive answers.",
  "For first AI bootstrap, call bootstrap_preview and show its disclosure manifest to the user. Only after explicit approval call bootstrap_start. When next_batch sets fastPath, submit that file summary directly; it records the single chunk and the file together. Multi-chunk files still use submit_chunk_summaries and then next_rollups. Page bootstrap_context, propose a sourced graph patch, validate it, obtain approval, apply it, then call bootstrap_complete. Never apply a patch without validation and user approval.",
  "After sync, call review_context. It classifies each pending file and returns one candidate patch for implementation-only edits and pure file moves. Validate and apply that patch only after user approval.",
  "Unsupported artifact projection rule: call unsupported_list or inspect bootstrap_preview instead of assuming the eligible-text manifest covers every repository artifact. Never ignore a relevant unsupported artifact, decode binary bytes as text, or invent a summary. After explicit approval to read it, use an available format-aware tool to construct a deterministic .strellis.json or .strellis.md projection bound to the reported source path and SHA-256, with media type, tool and version, preserved structure, omissions, and warnings. Call projection_validate, present its exact target and effects for approval, then call projection_register with the unchanged document and token. Never write or overwrite a projection directly. Regenerate only stale projections, restart bootstrap after registration, and report a blocker when approval or a capable tool is unavailable.",
].join(" ");

function success<T extends Record<string, unknown>>(value: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    structuredContent: { ...value },
  };
}

function failure(error: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

async function safe<T extends Record<string, unknown>>(
  action: () => Promise<T>,
) {
  try {
    return success(await action());
  } catch (error) {
    return failure(error);
  }
}

async function safeText(action: () => Promise<unknown>) {
  try {
    return {
      content: [{ type: "text" as const, text: JSON.stringify(await action(), null, 2) }],
    };
  } catch (error) {
    return failure(error);
  }
}

export function createSemanticTrellisMcpServer(repositoryRoot: string): McpServer {
  const root = resolve(repositoryRoot);
  const server = new McpServer(
    {
      name: "semantic-trellis",
      version: VERSION,
      websiteUrl: "https://github.com/HoodHou/SemanticTrellis",
    },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "semantic_trellis_bootstrap_preview",
    {
      title: "Preview AI Bootstrap Disclosure",
      description:
        "List the eligible files, bytes, extensions, largest files, suspicious paths, and up to 500 automatically discovered unsupported artifacts with projection state. Returns no source or binary content and changes no repository files.",
      inputSchema: z.object({}),
      outputSchema: agentBootstrapPreviewOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await previewAgentBootstrap(root)) })),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_start",
    {
      title: "Start or Resume Full AI Bootstrap",
      description:
        "Freeze the current repository snapshot, refresh structural evidence, plan source chunks, and resume summaries for unchanged content. Requires explicit approval to disclose source chunks to the connected Agent model.",
      inputSchema: z.object({
        sourceDisclosureApproved: z.literal(true).describe(
          "Must be true only after the user explicitly authorizes sending eligible repository text to the connected Agent model.",
        ),
        maxChunkCharacters: z.number().int().min(2_000).max(50_000).default(12_000),
      }),
      outputSchema: agentBootstrapStartOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourceDisclosureApproved, maxChunkCharacters }) =>
      safe(async () => ({
        ...(await startAgentBootstrap(root, {
          sourceDisclosureApproved,
          maxChunkCharacters,
        })),
      })),
  );

  server.registerTool(
    "semantic_trellis_unsupported_list",
    {
      title: "List Unsupported Repository Artifacts",
      description:
        "Discover every Git-visible, non-excluded artifact outside the eligible text policy, hash it with stat-assisted reuse, and report projection state. Page with offset and limit for complete coverage.",
      inputSchema: z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        pathPrefix: z.string().min(1).optional(),
      }),
      outputSchema: unsupportedArtifactListSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ offset, limit, pathPrefix }) =>
      safe(async () => ({
        ...(await listUnsupportedArtifacts(root, offset, limit, pathPrefix)),
      })),
  );

  server.registerTool(
    "semantic_trellis_projection_status",
    {
      title: "Read Artifact Projection Status",
      description:
        "Refresh and report current, stale, invalid, unprojected, and orphaned projections with changed-file-only hash metrics.",
      inputSchema: z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(500).default(100),
        pathPrefix: z.string().min(1).optional(),
      }),
      outputSchema: projectionStatusOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ offset, limit, pathPrefix }) =>
      safe(async () => ({
        ...(await getProjectionStatus(root, offset, limit, pathPrefix)),
      })),
  );

  server.registerTool(
    "semantic_trellis_projection_validate",
    {
      title: "Validate Artifact Projection",
      description:
        "Validate and normalize a proposed .strellis.json or .strellis.md document without writing. Returns a token bound to the source hash, normalized projection, exact target, and current target contents.",
      inputSchema: z.object({
        projectionPath: z.string().min(1),
        content: z.string().min(1).max(1_500_000),
      }),
      outputSchema: projectionValidationOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ projectionPath, content }) =>
      safe(async () => ({
        ...(await validateArtifactProjection(root, projectionPath, content)),
      })),
  );

  server.registerTool(
    "semantic_trellis_projection_register",
    {
      title: "Register Validated Artifact Projection",
      description:
        "Write the normalized projection sidecar at the source-bound path using the exact document and validation token. Rejects changed source, content, or target state and never modifies the original artifact.",
      inputSchema: z.object({
        projectionPath: z.string().min(1),
        content: z.string().min(1).max(1_500_000),
        validationToken: z.string().length(64),
      }),
      outputSchema: projectionRegistrationOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ projectionPath, content, validationToken }) =>
      safe(async () => ({
        ...(await registerArtifactProjection(
          root,
          projectionPath,
          content,
          validationToken,
        )),
      })),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_status",
    {
      title: "Read AI Bootstrap Status",
      description:
        "Return full-review coverage, resumability metrics, current bootstrap stage, and completion digest.",
      inputSchema: z.object({}),
      outputSchema: agentBootstrapStatusSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await getAgentBootstrapStatus(root)) })),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_next_batch",
    {
      title: "Read Next Source Review Batch",
      description:
        "Return the next unsummarized frozen source chunks for AI review. Single-chunk files set fastPath and include structural symbols so one file summary can satisfy both chunk and file coverage. Source content is returned only when bootstrap_start recorded explicit disclosure approval.",
      inputSchema: z.object({
        maxCharacters: z.number().int().min(1_000).max(200_000).default(48_000),
        maxUnits: z.number().int().min(1).max(50).default(12),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ maxCharacters, maxUnits }) =>
      safeText(() => getNextBootstrapSourceBatch(root, maxCharacters, maxUnits)),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_submit_chunk_summaries",
    {
      title: "Submit AI Chunk Summaries",
      description:
        "Checkpoint AI summaries for exact frozen source chunks. Repeating the same submission is idempotent.",
      inputSchema: z.object({
        sessionId: z.string().length(64),
        summaries: z.array(chunkSummarySubmissionSchema).min(1).max(50),
      }),
      outputSchema: agentBootstrapStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, summaries }) =>
      safe(async () => ({
        ...(await submitBootstrapChunkSummaries(root, sessionId, summaries)),
      })),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_next_rollups",
    {
      title: "Read Next File Rollup Batch",
      description:
        "Return files whose chunks are fully summarized, together with chunk summaries and structural symbols, for AI file-level synthesis.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(25).default(5) }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ limit }) => safeText(() => getNextBootstrapRollups(root, limit)),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_submit_file_summaries",
    {
      title: "Submit AI File Summaries",
      description:
        "Checkpoint file-level semantic summaries. A single-chunk file can be submitted before its chunk summary; the server derives that chunk summary from the file summary. Multi-chunk files still require every chunk summary first.",
      inputSchema: z.object({
        sessionId: z.string().length(64),
        summaries: z.array(fileSemanticSummarySchema).min(1).max(25),
      }),
      outputSchema: agentBootstrapStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, summaries }) =>
      safe(async () => ({
        ...(await submitBootstrapFileSummaries(root, sessionId, summaries)),
      })),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_context",
    {
      title: "Read AI Curation Context",
      description:
        "Page through completed file summaries so the Curator Agent can classify systems and propose a sourced graph patch.",
      inputSchema: z.object({
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ offset, limit }) => safeText(() => getBootstrapCurationContext(root, offset, limit)),
  );

  server.registerTool(
    "semantic_trellis_bootstrap_complete",
    {
      title: "Complete AI Bootstrap",
      description:
        "Mark bootstrap complete only after every file is summarized and an audit-clean curated graph with the supplied digest has been applied.",
      inputSchema: z.object({
        sessionId: z.string().length(64),
        graphDigest: z.string().length(64),
      }),
      outputSchema: agentBootstrapStatusSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sessionId, graphDigest }) =>
      safe(async () => ({ ...(await finishAgentBootstrap(root, sessionId, graphDigest)) })),
  );

  server.registerTool(
    "semantic_trellis_status",
    {
      title: "SemanticTrellis Status",
      description:
        "Return bootstrap state, file count, curated graph size, and pending review count for the fixed repository.",
      inputSchema: z.object({}),
      outputSchema: statusOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await projectStatus(root)) })),
  );

  server.registerTool(
    "semantic_trellis_graph",
    {
      title: "Read Curated Graph",
      description:
        "Return the complete curated semantic graph or a bounded incoming, outgoing, or bidirectional neighborhood around one stable node ID.",
      inputSchema: z.object({
        nodeId: z.string().min(1).optional().describe("Stable node ID. Omit for the complete curated graph."),
        depth: z.number().int().min(0).max(8).default(1),
        direction: z.enum(["both", "incoming", "outgoing"]).default("both"),
      }),
      outputSchema: graphOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ nodeId, depth, direction }) =>
      safe(async () => ({
        ...graphNeighborhood(await loadGraph(root), nodeId ?? null, depth, direction),
      })),
  );

  server.registerTool(
    "semantic_trellis_search",
    {
      title: "Search Curated Graph",
      description:
        "Search stable nodes by ID, name, kind, summary, tags, and repository-relative source path.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      outputSchema: searchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit }) =>
      safe(async () => ({ query, hits: searchGraph(await loadGraph(root), query, limit) })),
  );

  server.registerTool(
    "semantic_trellis_review_queue",
    {
      title: "Read Review Queue",
      description:
        "Return repository changes waiting for semantic review, including the curated nodes related through source provenance.",
      inputSchema: z.object({
        pathPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: reviewQueueOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pathPrefix, limit }) =>
      safe(async () => {
        const queue = await loadReviewQueue(root);
        const prefix = pathPrefix
          ?.replace(/\\/g, "/")
          .replace(/^\.\//, "")
          .replace(/\/+$/, "");
        const matching = prefix === undefined || prefix.length === 0
          ? queue.items
          : queue.items.filter(
              (item) => item.path === prefix || item.path.startsWith(`${prefix}/`),
            );
        const items = matching.slice(0, limit);
        return { total: matching.length, returned: items.length, items };
      }),
  );

  server.registerTool(
    "semantic_trellis_review_context",
    {
      title: "Read Incremental Review Context",
      description:
        "Build a compact review package for the pending queue: structural change class, changed symbols, cross-file reference deltas, affected curated-node summaries, and a candidate patch that marks implementation-only edits and pure file moves reviewed.",
      inputSchema: z.object({
        pathPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
      }),
      outputSchema: reviewContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pathPrefix, limit }) =>
      safe(async () => ({
        ...(await buildReviewContext(root, pathPrefix, limit)),
      })),
  );

  server.registerTool(
    "semantic_trellis_audit",
    {
      title: "Audit Curated Graph",
      description:
        "Audit graph integrity, source provenance, stale paths, and unclassified sources without changing repository state.",
      inputSchema: z.object({
        severity: z.enum(["all", "error", "warning", "info"]).default("all"),
        limit: z.number().int().min(1).max(1000).default(200),
      }),
      outputSchema: auditOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ severity, limit }) =>
      safe(async () => {
        const audit = await auditProject(root);
        const issues = audit.issues
          .filter((issue) => severity === "all" || issue.severity === severity)
          .slice(0, limit);
        return {
          projectId: audit.projectId,
          errors: audit.errors,
          warnings: audit.warnings,
          information: audit.information,
          issues,
        };
      }),
  );

  server.registerTool(
    "semantic_trellis_sync",
    {
      title: "Sync Repository Delta",
      description:
        "Scan the fixed repository, update disposable local snapshot state, and queue changed files for review. This never edits the curated graph.",
      inputSchema: z.object({}),
      outputSchema: syncOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await syncProject(root)) })),
  );

  server.registerTool(
    "semantic_trellis_structure",
    {
      title: "Refresh Structural Contributions",
      description:
        "Build or incrementally refresh disposable per-file symbols, references, and resolved structural edges for the fixed repository.",
      inputSchema: z.object({}),
      outputSchema: structuralBuildMetricsSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => safe(async () => ({ ...(await buildStructuralIndex(root)).metrics })),
  );

  server.registerTool(
    "semantic_trellis_grep",
    {
      title: "Symbol-Aware Structural Grep",
      description:
        "Search indexed source exhaustively, repair stale contributions once, group matches by symbol importance, deprioritize tests and synthetic callbacks, and optionally filter by symbol kind or return bounded source context.",
      inputSchema: z.object({
        pattern: z.string().min(1),
        fixed: z.boolean().default(true),
        ignoreCase: z.boolean().default(false),
        pathPrefix: z.string().optional(),
        symbolKinds: z.array(z.enum(STRUCTURAL_SYMBOL_KINDS)).optional(),
        limit: z.number().int().min(1).max(5_000).default(2_000),
        maxHitsPerGroup: z.number().int().min(1).max(500).default(50),
        contextLines: z.number().int().min(0).max(20).default(0),
        includeBody: z.boolean().default(false),
        maxSourceCharacters: z.number().int().min(0).max(200_000).default(20_000),
      }),
      outputSchema: structuralGrepOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      pattern,
      fixed,
      ignoreCase,
      pathPrefix,
      symbolKinds,
      limit,
      maxHitsPerGroup,
      contextLines,
      includeBody,
      maxSourceCharacters,
    }) =>
      safe(async () => ({
        ...(await grepStructure(root, pattern, {
          fixed,
          ignoreCase,
          ...(pathPrefix === undefined ? {} : { pathPrefix }),
          ...(symbolKinds === undefined ? {} : { symbolKinds }),
          limit,
          maxHitsPerGroup,
          contextLines,
          includeBody,
          maxSourceCharacters,
          refresh: false,
          repairStale: true,
        })),
      })),
  );

  server.registerTool(
    "semantic_trellis_file_symbols",
    {
      title: "Read File Symbols",
      description:
        "Return every symbol and source span extracted from one exact repository path or unique basename, repairing stale contributions and optionally including bounded bodies.",
      inputSchema: z.object({
        file: z.string().min(1),
        includeBody: z.boolean().default(false),
        maxSourceCharacters: z.number().int().min(0).max(200_000).default(20_000),
      }),
      outputSchema: fileSymbolsOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ file, includeBody, maxSourceCharacters }) =>
      safe(async () => ({
        ...(await getFileSymbols(root, file, false, {
          includeBody,
          maxSourceCharacters,
          repairStale: true,
        })),
      })),
  );

  server.registerTool(
    "semantic_trellis_trace",
    {
      title: "Trace Structural References",
      description:
        "Trace resolved incoming callers or outgoing dependencies around a symbol, repair stale contributions, return near-name suggestions on misses, and optionally include bounded bodies.",
      inputSchema: z.object({
        query: z.string().min(1),
        direction: z.enum(["incoming", "outgoing", "both"]).default("incoming"),
        depth: z.number().int().min(0).max(8).default(1),
        includeBody: z.boolean().default(false),
        maxSourceCharacters: z.number().int().min(0).max(200_000).default(20_000),
      }),
      outputSchema: structuralTraceOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, direction, depth, includeBody, maxSourceCharacters }) =>
      safe(async () => ({
        ...(await traceProjectStructure(root, query, direction, depth, false, {
          includeBody,
          maxSourceCharacters,
          repairStale: true,
        })),
      })),
  );

  server.registerTool(
    "semantic_trellis_symbol_search",
    {
      title: "Search Structural Symbols",
      description:
        "Rank symbols by natural-language terms across names, qualified names, signatures, paths, incoming degree, and curated provenance.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(100).default(20),
        pathPrefix: z.string().optional(),
      }),
      outputSchema: structuralSymbolSearchOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, pathPrefix }) =>
      safe(async () => ({
        ...(await searchProjectSymbols(
          root,
          query,
          limit,
          false,
          true,
          pathPrefix ?? null,
        )),
      })),
  );

  server.registerTool(
    "semantic_trellis_ask",
    {
      title: "Ask About Repository Code",
      description:
        "Answer a natural-language repository question with ranked symbols, bounded verified source bodies, up to two 1-hop callee cruxes, and up to two matching curated-node summaries.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(4),
        pathPrefix: z.string().optional(),
        includeBody: z.boolean().default(true),
        fullBody: z.boolean().default(false),
        maxSourceCharacters: z.number().int().min(0).max(200_000).optional(),
      }),
      outputSchema: structuralAskOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, limit, pathPrefix, includeBody, fullBody, maxSourceCharacters }) =>
      safe(async () => ({
        ...(await askProject(root, query, {
          limit,
          ...(pathPrefix === undefined ? {} : { pathPrefix }),
          includeBody,
          fullBody,
          ...(maxSourceCharacters === undefined ? {} : { maxSourceCharacters }),
          refresh: false,
          repairStale: true,
        })),
      })),
  );

  server.registerTool(
    "semantic_trellis_validate_patch",
    {
      title: "Validate Curation Patch",
      description:
        "Apply a proposed patch in memory, run repository-aware audit, and return a token bound to the exact patch, current graph, and selected review entries. Call this before apply_patch.",
      inputSchema: z.object({ patch: graphPatchSchema }),
      outputSchema: validationOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ patch }) =>
      safe(async () => ({ ...(await validateCurationPatch(root, asGraphPatch(patch))) })),
  );

  server.registerTool(
    "semantic_trellis_apply_patch",
    {
      title: "Apply Validated Curation Patch",
      description:
        "Modify the versioned curated graph using the exact patch and validation token returned by validate_patch. Rejects changed graph, patch, or selected review entries.",
      inputSchema: z.object({
        patch: graphPatchSchema,
        validationToken: z.string().length(64),
      }),
      outputSchema: applyOutputSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ patch, validationToken }) =>
      safe(async () => ({
        ...(await applyValidatedCurationPatch(
          root,
          asGraphPatch(patch),
          validationToken,
        )),
      })),
  );

  server.registerResource(
    "semantic-trellis-status",
    "semantic-trellis://status",
    {
      title: "SemanticTrellis Status",
      description: "Current bootstrap, graph, and review state for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await projectStatus(root), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "semantic-trellis-graph",
    "semantic-trellis://graph",
    {
      title: "Curated Semantic Graph",
      description: "The complete canonical semantic graph for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await loadGraph(root), null, 2),
        },
      ],
    }),
  );

  server.registerResource(
    "semantic-trellis-review-queue",
    "semantic-trellis://review-queue",
    {
      title: "Semantic Review Queue",
      description: "Up to 200 pending review items for the fixed repository.",
      mimeType: "application/json",
    },
    async (uri) => {
      const queue = await loadReviewQueue(root);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(
              { total: queue.items.length, items: queue.items.slice(0, 200) },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
