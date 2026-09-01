import { join, resolve } from "node:path";

export const METADATA_DIRECTORY = ".semantic-trellis";

export interface ProjectLayout {
  root: string;
  metadataDirectory: string;
  configFile: string;
  graphFile: string;
  localDirectory: string;
  snapshotFile: string;
  reviewQueueFile: string;
  structuralIndexFile: string;
  agentBootstrapFile: string;
  projectionIndexFile: string;
}

export function projectLayout(root: string): ProjectLayout {
  const absoluteRoot = resolve(root);
  const metadataDirectory = join(absoluteRoot, METADATA_DIRECTORY);
  const localDirectory = join(metadataDirectory, "local");
  return {
    root: absoluteRoot,
    metadataDirectory,
    configFile: join(metadataDirectory, "config.json"),
    graphFile: join(metadataDirectory, "graph.json"),
    localDirectory,
    snapshotFile: join(localDirectory, "snapshot.json"),
    reviewQueueFile: join(localDirectory, "review-queue.json"),
    structuralIndexFile: join(localDirectory, "structural-index.json"),
    agentBootstrapFile: join(localDirectory, "agent-bootstrap.json"),
    projectionIndexFile: join(localDirectory, "projection-index.json"),
  };
}
