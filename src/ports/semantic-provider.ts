import type {
  CuratedGraph,
  FileChange,
  GraphPatch,
  RepositorySnapshot,
} from "../domain/model.js";

export interface BootstrapContext {
  repositoryRoot: string;
  snapshot: RepositorySnapshot;
}

export interface MaintenanceContext {
  repositoryRoot: string;
  graph: CuratedGraph;
  changes: FileChange[];
}

export interface SemanticProvider {
  proposeBootstrap(context: BootstrapContext): Promise<GraphPatch>;
  proposeMaintenance(context: MaintenanceContext): Promise<GraphPatch>;
}
