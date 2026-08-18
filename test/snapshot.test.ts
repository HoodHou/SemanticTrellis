import { describe, expect, it } from "vitest";
import { createSnapshot, diffSnapshots } from "../src/domain/snapshot.js";

describe("snapshot diff", () => {
  it("reports added, changed, and removed files deterministically", () => {
    const previous = createSnapshot([
      { path: "src/removed.ts", hash: "old-removed", size: 10 },
      { path: "src/changed.ts", hash: "old", size: 20 },
      { path: "src/stable.ts", hash: "stable", size: 30 },
    ]);
    const current = createSnapshot([
      { path: "src/added.ts", hash: "new-added", size: 5 },
      { path: "src/changed.ts", hash: "new", size: 21 },
      { path: "src/stable.ts", hash: "stable", size: 30 },
    ]);

    const changes = diffSnapshots(previous, current);

    expect(changes.map((change) => [change.kind, change.path])).toEqual([
      ["added", "src/added.ts"],
      ["changed", "src/changed.ts"],
      ["removed", "src/removed.ts"],
    ]);
  });
});
