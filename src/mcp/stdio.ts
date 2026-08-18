#!/usr/bin/env node

import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSemanticTrellisMcpServer } from "./server.js";

export function serveSemanticTrellisStdio(repositoryRoot: string): StdioServerHandle {
  const root = resolve(repositoryRoot);
  const handle = serveStdio(() => createSemanticTrellisMcpServer(root));
  console.error(`[semantic-trellis] MCP server ready for ${root}`);
  return handle;
}

function installShutdown(handle: StdioServerHandle): void {
  const close = () => {
    void handle.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const root = process.argv[2] ?? process.env.SEMANTIC_TRELLIS_ROOT ?? process.cwd();
  installShutdown(serveSemanticTrellisStdio(root));
}
