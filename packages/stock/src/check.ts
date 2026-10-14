import { checkModule, readModuleSources } from "@graft/check";
import type { StockCheck } from "@graft/core";

/**
 * The check over one stock tool, as the catalogue's load runs it for a version about to be
 * appended (`@graft/core`'s `loadStockCatalogue`; GRA-238): the module against its own schema, with
 * no package, exactly as a publish checks a draft. The annotations the catalogue records are this
 * check's, never the manifest's (ADR 0008); `workspace.test.ts` proves the two agree.
 */
export const checkStockTool: StockCheck = async (source) => {
  const modules = readModuleSources(source.files);
  const result = await checkModule({
    files: modules.files,
    entry: modules.entry,
    inputSchema: source.inputSchema,
    dependencies: [],
  });
  if (result.refusals.length > 0) {
    return {
      ok: false,
      problems: result.refusals.map((refusal) => `${refusal.rule}: ${refusal.message}`),
    };
  }
  return {
    ok: true,
    annotations: result.annotations,
    checkOutput: {
      entry: result.entry,
      refusals: result.refusals,
      advice: result.advice,
      annotations: result.annotations,
    },
  };
};
