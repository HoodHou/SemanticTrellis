import csharp from "@ast-grep/lang-csharp";
import python from "@ast-grep/lang-python";
import { registerDynamicLanguage } from "@ast-grep/napi";

let registered = false;

export function ensureAstGrepLanguages(): void {
  if (registered) return;
  registerDynamicLanguage({ csharp, python });
  registered = true;
}
