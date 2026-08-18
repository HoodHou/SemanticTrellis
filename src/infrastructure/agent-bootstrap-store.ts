import {
  AGENT_BOOTSTRAP_SCHEMA_VERSION,
  type AgentBootstrapSession,
} from "../domain/agent-bootstrap.js";
import { readJsonFileOrNull, writeJsonFile } from "./json-store.js";
import { projectLayout } from "./layout.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function loadAgentBootstrapSession(
  root: string,
): Promise<AgentBootstrapSession | null> {
  const value = await readJsonFileOrNull(projectLayout(root).agentBootstrapFile);
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== AGENT_BOOTSTRAP_SCHEMA_VERSION) return null;
  if (!Array.isArray(value.units) || !isRecord(value.fileSummaries)) return null;
  return value as unknown as AgentBootstrapSession;
}

export async function saveAgentBootstrapSession(
  root: string,
  session: AgentBootstrapSession,
): Promise<void> {
  await writeJsonFile(projectLayout(root).agentBootstrapFile, session);
}
