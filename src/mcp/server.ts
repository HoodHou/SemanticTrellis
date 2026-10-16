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
  "One fixed repository. Use ask to discover, grep or trace for an exact lookup, and review_context after sync.",
  "Never apply a patch without validation and user approval.",
  "Unsupported artifact projection rule: Never ignore a relevant unsupported artifact or decode it as text. After approval, bind a .strellis.json or .strellis.md sidecar, call projection_validate, then projection_register. Never write a projection directly.",
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
        "List eligible files and unsupported artifacts. Returns no source or binary content.",
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
        "Freeze the snapshot and resume AI bootstrap. Requires explicit source-disclosure approval.",
      inputSchema: z.object({
        sourceDisclosureApproved: z.literal(true).describe(
          "True only after the user approves source disclosure.",
        ),
        maxChunkCharacters: z.number().int().min(2_000).max(50_000).default(20_000),
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
        "Page unsupported artifacts and their projection state. No binary content.",
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
        "Report projection health.",
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
        "Validate a projection without writing it. Returns a registration token.",
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
        "Register a validated projection sidecar. Does not modify the original artifact.",
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
        "Return bootstrap coverage and stage.",
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
        "Return the next unsummarized source chunks. fastPath files include symbols and accept one file summary.",
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
        "Save chunk summaries for the frozen snapshot.",
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
        "Return files ready for a file-level summary.",
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
        "Save file summaries. A fastPath file may be submitted before its chunk summary.",
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
        "Page completed file summaries.",
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
        "Complete bootstrap when coverage is total and the graph audit is clean.",
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
        "Return project status.",
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
        "Return the curated graph or a neighborhood around one node.",
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
        "Search curated nodes.",
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
        "Return pending review items.",
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
        "Return structural review deltas, a safe candidatePatch, and a draftPatch that does not mark items reviewed.",
      inputSchema: z.object({
        pathPrefix: z.string().optional(),
        limit: z.number().int().min(1).max(500).default(100),
        includeUnclassified: z.boolean().default(false),
      }),
      outputSchema: reviewContextOutputSchema,
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ pathPrefix, limit, includeUnclassified }) =>
      safe(async () => ({
        ...(await buildReviewContext(root, pathPrefix, limit, includeUnclassified)),
      })),
  );

  server.registerTool(
    "semantic_trellis_audit",
    {
      title: "Audit Curated Graph",
      description:
        "Audit the curated graph without writing it.",
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
        "Record repository deltas for review. Does not edit the curated graph.",
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
        "Refresh the disposable structural index.",
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
        "Search source and group hits by symbol. Test matches drop when a production hit exists.",
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
        "List symbols for one file.",
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
        "Trace callers or callees of one symbol.",
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
        "Rank symbols by natural-language terms.",
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
        "Answer with ranked symbols, short source, up to two callee cruxes, and matching curated nodes.",
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
        "Validate a patch in memory and return a token. Call this before apply_patch.",
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
        "Apply the exact patch and token from validate_patch.",
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
