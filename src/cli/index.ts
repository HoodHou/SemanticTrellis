#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditProject,
  buildStructuralIndex,
  curateProject,
  getAgentBootstrapStatus,
  getFileSymbols,
  grepStructure,
  initializeProject,
  previewAgentBootstrap,
  projectStatus,
  searchProjectSymbols,
  startAgentBootstrap,
  syncProject,
  traceProjectStructure,
} from "../application/index.js";
import type { AuditIssue } from "../domain/model.js";
import { VERSION } from "../version.js";

const HELP = `SemanticTrellis ${VERSION}

Usage:
  strellis init [repository]
  strellis bootstrap [repository] [--allow-source-disclosure] [--max-chunk-characters N]
  strellis bootstrap-preview [repository]
  strellis bootstrap-status [repository]
  strellis curate <patch-file> [repository]
  strellis sync [repository]
  strellis audit [repository]
  strellis status [repository]
  strellis structure [repository] [--json]
  strellis grep <pattern> [repository] [--regex] [--ignore-case] [--in <path>] [--context-lines N] [--include-body] [--json]
  strellis symbols <file> [repository] [--include-body] [--json]
  strellis trace <symbol> [repository] [--direction incoming|outgoing|both] [--depth N] [--include-body] [--json]
  strellis search-symbols <query> [repository] [--limit N] [--json]
  strellis mcp [repository]
  strellis version
  strellis help

Lifecycle:
  init       Create versioned project metadata and an empty curated graph.
  bootstrap  Freeze the repository and start or resume full Agent-driven AI review.
  bootstrap-preview  Show the source-disclosure manifest without returning source.
  bootstrap-status  Show full-review coverage and current bootstrap stage.
  curate     Apply an explicit, validated graph patch.
  sync       Record repository deltas without rewriting approved meaning.
  audit      Verify graph integrity, provenance, and source coverage.
  status     Show the current repository and review state.
  structure  Build or incrementally refresh disposable structural contributions.
  grep       Search indexed source and group hits by the innermost symbol.
  symbols    List symbols extracted from one source file.
  trace      Walk resolved structural references around a symbol.
  search-symbols  Rank structural symbols by natural-language terms and graph importance.
  mcp        Serve SemanticTrellis tools and resources over stdio.
`;

export interface CliIo {
  out(message: string): void;
  error(message: string): void;
}

const consoleIo: CliIo = {
  out: (message) => console.log(message),
  error: (message) => console.error(message),
};

function rootFrom(argument: string | undefined): string {
  return resolve(argument ?? process.cwd());
}

function formatIssue(issue: AuditIssue): string {
  return `${issue.severity.toUpperCase()} ${issue.code} [${issue.subject}] ${issue.message}`;
}

interface ParsedArguments {
  positionals: string[];
  flags: Set<string>;
  options: Map<string, string>;
}

function parseArguments(values: string[], valueOptions: Set<string> = new Set()): ParsedArguments {
  const positionals: string[] = [];
  const flags = new Set<string>();
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === undefined) continue;
    if (valueOptions.has(value)) {
      const optionValue = values[index + 1];
      if (optionValue === undefined) throw new Error(`${value} requires a value.`);
      options.set(value, optionValue);
      index += 1;
    } else if (value.startsWith("-")) {
      flags.add(value);
    } else {
      positionals.push(value);
    }
  }
  return { positionals, flags, options };
}

function positiveInteger(value: string | undefined, fallback: number, option: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} must be a non-negative integer.`);
  return parsed;
}

export async function runCli(args: string[], io: CliIo = consoleIo): Promise<number> {
  const [command = "help", ...rest] = args;

  try {
    switch (command) {
      case "help":
      case "--help":
      case "-h":
        io.out(HELP.trimEnd());
        return 0;
      case "version":
      case "--version":
      case "-v":
        io.out(VERSION);
        return 0;
      case "init": {
        const result = await initializeProject(rootFrom(rest[0]));
        io.out(`Initialized ${result.projectId} at ${result.root}`);
        io.out(`Config: ${result.createdConfig ? "created" : "unchanged"}`);
        io.out(`Graph: ${result.createdGraph ? "created" : "unchanged"}`);
        return 0;
      }
      case "bootstrap": {
        const parsed = parseArguments(rest, new Set(["--max-chunk-characters"]));
        const result = await startAgentBootstrap(rootFrom(parsed.positionals[0]), {
          sourceDisclosureApproved: parsed.flags.has("--allow-source-disclosure"),
          maxChunkCharacters: positiveInteger(
            parsed.options.get("--max-chunk-characters"),
            12_000,
            "--max-chunk-characters",
          ),
        });
        io.out(
          `AI bootstrap ${result.status.sessionId}: ${result.status.stage}, ` +
            `${result.status.summarizedChunks}/${result.status.totalChunks} chunks, ` +
            `${result.status.summarizedFiles}/${result.status.totalFiles} files.`,
        );
        if (!result.status.sourceDisclosureApproved) {
          io.out(
            "Source disclosure is not approved. Re-run with --allow-source-disclosure after explicit user approval.",
          );
        }
        return 0;
      }
      case "bootstrap-preview": {
        const result = await previewAgentBootstrap(rootFrom(rest[0]));
        io.out(JSON.stringify(result, null, 2));
        return 0;
      }
      case "bootstrap-status": {
        const result = await getAgentBootstrapStatus(rootFrom(rest[0]));
        io.out(JSON.stringify(result, null, 2));
        return 0;
      }
      case "sync": {
        const result = await syncProject(rootFrom(rest[0]));
        io.out(
          `Sync complete: ${result.changes} changes ` +
            `(${result.byKind.added} added, ${result.byKind.changed} changed, ${result.byKind.removed} removed).`,
        );
        io.out(`${result.pendingReviews} review items are pending.`);
        if (result.fullAuditRecommended) {
          io.out("A full audit is recommended because the change ratio crossed the configured threshold.");
        }
        return 0;
      }
      case "curate": {
        const patchFile = rest[0];
        if (patchFile === undefined) throw new Error("curate requires a patch file.");
        const result = await curateProject(rootFrom(rest[1]), resolve(patchFile));
        io.out(`Curated graph: ${result.nodes} nodes, ${result.edges} edges.`);
        io.out(
          `Reviewed ${result.reviewedPaths} paths; ${result.pendingReviews} review items remain.`,
        );
        return 0;
      }
      case "audit": {
        const result = await auditProject(rootFrom(rest[0]));
        io.out(
          `Audit ${result.projectId}: ${result.errors} errors, ${result.warnings} warnings, ` +
            `${result.information} informational issues.`,
        );
        const important = result.issues.filter((issue) => issue.severity !== "info");
        for (const issue of important.slice(0, 20)) io.out(formatIssue(issue));
        if (important.length > 20) io.out(`... ${important.length - 20} more warnings or errors.`);
        return result.errors === 0 ? 0 : 1;
      }
      case "status": {
        const result = await projectStatus(rootFrom(rest[0]));
        io.out(`Project: ${result.projectId}`);
        io.out(`Inventory snapshot: ${result.bootstrapped ? "yes" : "no"}`);
        io.out(`AI bootstrap: ${result.aiBootstrapStage ?? "not started"}`);
        io.out(`Files: ${result.files}`);
        io.out(`Curated graph: ${result.nodes} nodes, ${result.edges} edges`);
        io.out(`Pending reviews: ${result.pendingReviews}`);
        return 0;
      }
      case "structure": {
        const parsed = parseArguments(rest);
        const result = await buildStructuralIndex(rootFrom(parsed.positionals[0]));
        if (parsed.flags.has("--json")) {
          io.out(JSON.stringify(result.metrics, null, 2));
        } else {
          io.out(
            `Structure: ${result.metrics.symbols} symbols, ${result.metrics.references} references, ` +
              `${result.metrics.edges} resolved edges, ${result.metrics.diagnostics} parse diagnostics ` +
              `in ${result.metrics.diagnosticFiles} files.`,
          );
          io.out(
            `Resolution: ${result.metrics.resolvedReferences} resolved, ` +
              `${result.metrics.ambiguousReferences} ambiguous, ` +
              `${result.metrics.unresolvedReferences} unresolved ` +
              `(${result.metrics.unknownReceiverReferences} unknown receivers).`,
          );
          io.out(
            `Files: ${result.metrics.parsedFiles} parsed, ${result.metrics.reusedFiles} reused, ` +
              `${result.metrics.removedFiles} removed, ${result.metrics.resolvedFiles} re-resolved ` +
              `(${result.metrics.durationMs} ms).`,
          );
        }
        return 0;
      }
      case "grep": {
        const parsed = parseArguments(
          rest,
          new Set(["--in", "--limit", "--context-lines", "--max-source-characters", "--max-hits-per-group"]),
        );
        const pattern = parsed.positionals[0];
        if (pattern === undefined) throw new Error("grep requires a pattern.");
        const result = await grepStructure(rootFrom(parsed.positionals[1]), pattern, {
          fixed: parsed.flags.has("--fixed") || !parsed.flags.has("--regex"),
          ignoreCase: parsed.flags.has("--ignore-case") || parsed.flags.has("-i"),
          ...(parsed.options.has("--in")
            ? { pathPrefix: parsed.options.get("--in") as string }
            : {}),
          limit: positiveInteger(parsed.options.get("--limit"), 2_000, "--limit"),
          refresh: parsed.flags.has("--refresh"),
          repairStale: !parsed.flags.has("--no-refresh"),
          contextLines: positiveInteger(
            parsed.options.get("--context-lines"),
            0,
            "--context-lines",
          ),
          includeBody: parsed.flags.has("--include-body"),
          maxSourceCharacters: positiveInteger(
            parsed.options.get("--max-source-characters"),
            20_000,
            "--max-source-characters",
          ),
          maxHitsPerGroup: positiveInteger(
            parsed.options.get("--max-hits-per-group"),
            50,
            "--max-hits-per-group",
          ),
        });
        if (parsed.flags.has("--json")) {
          io.out(JSON.stringify(result, null, 2));
        } else {
          io.out(
            `${JSON.stringify(pattern)}: ${result.totalHits} hits in ${result.groups.length} symbols ` +
              `across ${result.filesSearched} files.`,
          );
          for (const group of result.groups) {
            io.out(
              `${group.symbolName} · ${group.symbolKind} · ${group.path} · ` +
                `${group.inDegree} incoming edges`,
            );
            for (const hit of group.hits) {
              io.out(`  L${hit.line}:C${hit.column} ${hit.text}`);
              if (hit.context !== undefined) io.out(hit.context.text);
            }
            if (group.sourceContext !== undefined) io.out(group.sourceContext.text);
          }
        }
        return 0;
      }
      case "symbols": {
        const parsed = parseArguments(rest, new Set(["--max-source-characters"]));
        const file = parsed.positionals[0];
        if (file === undefined) throw new Error("symbols requires a file path or unique basename.");
        const result = await getFileSymbols(
          rootFrom(parsed.positionals[1]),
          file,
          parsed.flags.has("--refresh"),
          {
            includeBody: parsed.flags.has("--include-body"),
            maxSourceCharacters: positiveInteger(
              parsed.options.get("--max-source-characters"),
              20_000,
              "--max-source-characters",
            ),
            repairStale: !parsed.flags.has("--no-refresh"),
          },
        );
        if (parsed.flags.has("--json")) {
          io.out(JSON.stringify(result, null, 2));
        } else {
          for (const symbol of result.symbols) {
            io.out(
              `${symbol.qualifiedName} · ${symbol.kind} · ` +
                `L${symbol.span.startLine}-L${symbol.span.endLine} · ${symbol.signature}`,
            );
          }
          for (const source of result.sourceContexts) io.out(source.context.text);
        }
        return 0;
      }
      case "trace": {
        const parsed = parseArguments(
          rest,
          new Set(["--direction", "--depth", "--max-source-characters"]),
        );
        const query = parsed.positionals[0];
        if (query === undefined) throw new Error("trace requires a symbol ID or name.");
        const direction = parsed.options.get("--direction") ?? "incoming";
        if (!new Set(["incoming", "outgoing", "both"]).has(direction)) {
          throw new Error("--direction must be incoming, outgoing, or both.");
        }
        const result = await traceProjectStructure(
          rootFrom(parsed.positionals[1]),
          query,
          direction as "incoming" | "outgoing" | "both",
          positiveInteger(parsed.options.get("--depth"), 1, "--depth"),
          parsed.flags.has("--refresh"),
          {
            includeBody: parsed.flags.has("--include-body"),
            maxSourceCharacters: positiveInteger(
              parsed.options.get("--max-source-characters"),
              20_000,
              "--max-source-characters",
            ),
            repairStale: !parsed.flags.has("--no-refresh"),
          },
        );
        if (parsed.flags.has("--json")) {
          io.out(JSON.stringify(result, null, 2));
        } else {
          io.out(
            `Trace ${JSON.stringify(query)}: ${result.trace.symbols.length} symbols, ` +
              `${result.trace.edges.length} edges${result.trace.ambiguous ? " (ambiguous focus)" : ""}.`,
          );
          for (const edge of result.trace.edges) io.out(`${edge.from} -${edge.kind}-> ${edge.to}`);
          if (!result.trace.found) {
            for (const suggestion of result.trace.suggestions) {
              io.out(`  Did you mean ${suggestion.symbol.qualifiedName}?`);
            }
          }
          for (const source of result.sourceContexts) io.out(source.context.text);
        }
        return 0;
      }
      case "search-symbols": {
        const parsed = parseArguments(rest, new Set(["--limit"]));
        const query = parsed.positionals[0];
        if (query === undefined) throw new Error("search-symbols requires a query.");
        const result = await searchProjectSymbols(
          rootFrom(parsed.positionals[1]),
          query,
          positiveInteger(parsed.options.get("--limit"), 20, "--limit"),
          parsed.flags.has("--refresh"),
          !parsed.flags.has("--no-refresh"),
        );
        if (parsed.flags.has("--json")) io.out(JSON.stringify(result, null, 2));
        else {
          for (const hit of result.hits) {
            io.out(
              `${hit.symbol.qualifiedName} · ${hit.symbol.kind} · score ${hit.score.toFixed(1)} · ` +
                `${hit.symbol.path}:L${hit.symbol.span.startLine}`,
            );
          }
        }
        return 0;
      }
      case "mcp": {
        const { serveSemanticTrellisStdio } = await import("../mcp/stdio.js");
        serveSemanticTrellisStdio(rootFrom(rest[0]));
        return 0;
      }
      default:
        io.error(`Unknown command: ${command}`);
        io.error("Run `strellis help` for usage.");
        return 1;
    }
  } catch (error) {
    io.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
