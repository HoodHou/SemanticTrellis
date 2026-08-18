import { extname } from "node:path";
import { CSharpLanguageAdapter } from "../adapters/csharp/csharp-adapter.js";
import { TypeScriptLanguageAdapter } from "../adapters/typescript/typescript-adapter.js";
import type { LanguageAdapter } from "../ports/language-adapter.js";

export class LanguageRegistry {
  private readonly byExtension = new Map<string, LanguageAdapter>();

  constructor(adapters: LanguageAdapter[]) {
    for (const adapter of adapters) {
      for (const extension of adapter.extensions) {
        const normalized = extension.toLowerCase();
        if (this.byExtension.has(normalized)) {
          throw new Error(`More than one language adapter claims ${normalized}.`);
        }
        this.byExtension.set(normalized, adapter);
      }
    }
  }

  adapterFor(path: string): LanguageAdapter | null {
    return this.byExtension.get(extname(path).toLowerCase()) ?? null;
  }
}

export function createDefaultLanguageRegistry(): LanguageRegistry {
  return new LanguageRegistry([
    new CSharpLanguageAdapter(),
    new TypeScriptLanguageAdapter(),
  ]);
}
