import { describe, expect, it } from "vitest";
import { CSharpLanguageAdapter } from "../src/adapters/csharp/csharp-adapter.js";
import { resolveStructuralEdges, resolveStructuralGraph } from "../src/structural/resolver.js";
import { createDefaultLanguageRegistry } from "../src/structural/registry.js";

describe("C# language adapter", () => {
  it("extracts Unity-style declarations, owned calls, construction, and base references", () => {
    const source = `
using System;
namespace Game.Core
{
    public partial class Player<T> : BasePlayer, IRunner
    {
        private readonly Service service = new Service();
        public event Action Changed;
        public int Health { get; private set; }
        public Player(Service service) { this.service = service; }
        public void Run(int value)
        {
            Helper(value);
            this.Helper(value + 1);
            service.Execute<T>(value);
            var item = new Item(value);
        }
        private void Helper(int value) => Console.WriteLine(value);
        public static Player<T> operator +(Player<T> left, Player<T> right) => left;
    }
    public interface IRunner { void Run(int value); }
    public struct Position { public float X; }
    public record Snapshot(int Health);
    public enum State { Idle, Running }
    public delegate void Handler(int value);
}
`;
    const contribution = new CSharpLanguageAdapter().extract({
      path: "Assets/Scripts/Player.cs",
      hash: "hash",
      source,
    });

    expect(contribution.language).toBe("csharp");
    expect(contribution.symbols.map((symbol) => [symbol.kind, symbol.qualifiedName])).toEqual(
      expect.arrayContaining([
        ["module", "Game.Core"],
        ["class", "Game.Core.Player"],
        ["field", "Game.Core.Player.service"],
        ["event", "Game.Core.Player.Changed"],
        ["property", "Game.Core.Player.Health"],
        ["constructor", "Game.Core.Player.constructor"],
        ["method", "Game.Core.Player.Run"],
        ["method", "Game.Core.Player.Helper"],
        ["operator", "Game.Core.Player.operator +"],
        ["interface", "Game.Core.IRunner"],
        ["struct", "Game.Core.Position"],
        ["record", "Game.Core.Snapshot"],
        ["enum", "Game.Core.State"],
        ["delegate", "Game.Core.Handler"],
      ]),
    );

    const run = contribution.symbols.find((symbol) => symbol.qualifiedName === "Game.Core.Player.Run");
    const serviceField = contribution.symbols.find(
      (symbol) => symbol.qualifiedName === "Game.Core.Player.service",
    );
    const player = contribution.symbols.find((symbol) => symbol.qualifiedName === "Game.Core.Player");
    expect(contribution.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "construct",
          targetName: "Service",
          ownerSymbolId: serviceField?.id,
        }),
        expect.objectContaining({ kind: "call", targetName: "Helper", ownerSymbolId: run?.id }),
        expect.objectContaining({
          kind: "call",
          targetName: "Execute",
          targetQualifier: "service.Execute",
          ownerSymbolId: run?.id,
        }),
        expect.objectContaining({ kind: "construct", targetName: "Item", ownerSymbolId: run?.id }),
        expect.objectContaining({
          kind: "extends",
          targetName: "BasePlayer",
          ownerSymbolId: player?.id,
        }),
        expect.objectContaining({
          kind: "implements",
          targetName: "IRunner",
          ownerSymbolId: player?.id,
        }),
      ]),
    );
  });

  it("resolves calls within the owning type before falling back to global names", () => {
    const adapter = new CSharpLanguageAdapter();
    const service = adapter.extract({
      path: "Assets/Scripts/Service.cs",
      hash: "service",
      source: "namespace Game { class Service { public static void Execute() {} } }",
    });
    const caller = adapter.extract({
      path: "Assets/Scripts/Caller.cs",
      hash: "caller",
      source: `namespace Game {
        class Caller {
          void Run() { Execute(); Service.Execute(); var value = new Service(); }
          void Execute() {}
        }
      }`,
    });

    const edges = resolveStructuralEdges({
      [service.path]: service,
      [caller.path]: caller,
    });
    const callerRun = caller.symbols.find((symbol) => symbol.qualifiedName === "Game.Caller.Run");
    const callerExecute = caller.symbols.find(
      (symbol) => symbol.qualifiedName === "Game.Caller.Execute",
    );
    const serviceExecute = service.symbols.find(
      (symbol) => symbol.qualifiedName === "Game.Service.Execute",
    );
    const serviceType = service.symbols.find((symbol) => symbol.qualifiedName === "Game.Service");

    expect(edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: callerRun?.id, to: callerExecute?.id, kind: "call" }),
        expect.objectContaining({ from: callerRun?.id, to: serviceExecute?.id, kind: "call" }),
        expect.objectContaining({ from: callerRun?.id, to: serviceType?.id, kind: "construct" }),
      ]),
    );
  });

  it("registers .cs files in the default language registry", () => {
    expect(createDefaultLanguageRegistry().adapterFor("Assets/Scripts/Player.cs")?.id).toBe(
      "csharp",
    );
  });

  it("does not bind unknown receivers or constructors to unrelated unique names", () => {
    const adapter = new CSharpLanguageAdapter();
    const definitions = adapter.extract({
      path: "Assets/Scripts/Definitions.cs",
      hash: "definitions",
      source: `class AudioManager { void LogWarning() {} }
        class EqualityNames { int Vector2; }`,
    });
    const caller = adapter.extract({
      path: "Assets/Scripts/Consumer.cs",
      hash: "consumer",
      source: `class Consumer {
        void Run() { Debug.LogWarning("warning"); var value = new Vector2(); }
      }`,
    });
    const edges = resolveStructuralEdges({
      [definitions.path]: definitions,
      [caller.path]: caller,
    });
    const unrelatedIds = new Set(
      definitions.symbols
        .filter((symbol) => symbol.name === "LogWarning" || symbol.name === "Vector2")
        .map((symbol) => symbol.id),
    );

    expect(edges.some((edge) => unrelatedIds.has(edge.to))).toBe(false);
  });

  it("records parser diagnostics without discarding recoverable symbols", () => {
    const contribution = new CSharpLanguageAdapter().extract({
      path: "Assets/Scripts/Broken.cs",
      hash: "broken",
      source: "class Broken { void Run( { class Nested {} }",
    });

    expect(contribution.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "csharp-parse-error", path: "Assets/Scripts/Broken.cs" }),
      ]),
    );
  });

  it("reports unresolved overload ambiguity instead of silently dropping it", () => {
    const contribution = new CSharpLanguageAdapter().extract({
      path: "Assets/Scripts/Overloads.cs",
      hash: "overloads",
      source: `class Overloads {
        void Run() { Execute(1); }
        void Execute(int value) {}
        void Execute(string value) {}
      }`,
    });

    const resolved = resolveStructuralGraph({ [contribution.path]: contribution });
    expect(resolved.metrics).toMatchObject({
      resolvedReferences: 0,
      ambiguousReferences: 1,
      unresolvedReferences: 0,
    });
  });
});
