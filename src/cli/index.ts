#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditProject,
  bootstrapProject,
  curateProject,
  initializeProject,
  projectStatus,
  syncProject,
} from "../application/index.js";
import type { AuditIssue } from "../domain/model.js";
import { VERSION } from "../version.js";

const HELP = `SemanticTrellis ${VERSION}

Usage:
  strellis init [repository]
  strellis bootstrap [repository]
  strellis curate <patch-file> [repository]
  strellis sync [repository]
  strellis audit [repository]
  strellis status [repository]
  strellis version
  strellis help

Lifecycle:
  init       Create versioned project metadata and an empty curated graph.
  bootstrap  Inventory the complete repository and create the first review queue.
  curate     Apply an explicit, validated graph patch.
  sync       Record repository deltas without rewriting approved meaning.
  audit      Verify graph integrity, provenance, and source coverage.
  status     Show the current repository and review state.
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
        const result = await bootstrapProject(rootFrom(rest[0]));
        io.out(`Bootstrapped ${result.files} files.`);
        io.out(`Created ${result.reviewItems} review items.`);
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
        io.out(`Bootstrapped: ${result.bootstrapped ? "yes" : "no"}`);
        io.out(`Files: ${result.files}`);
        io.out(`Curated graph: ${result.nodes} nodes, ${result.edges} edges`);
        io.out(`Pending reviews: ${result.pendingReviews}`);
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
