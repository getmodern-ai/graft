import { parentPort, workerData } from "node:worker_threads";

import { checkModuleSync, type ModuleCheckInput } from "./module-check.core.ts";

/**
 * The worker thread's entry. Loads the compiler, runs the check once, posts the result and ends;
 * `module-check.ts` owns the budget and terminates the thread when it is not met.
 *
 * The one file in the package that imports a sibling with its `.ts` extension, because Node loads it
 * natively (no bundler, no `tsx` hook in a fresh thread) and Node's own resolution takes the literal
 * file name. `allowImportingTsExtensions` in `tsconfig.json` is what lets `tsc` accept the same line.
 */
const input = workerData as ModuleCheckInput;
parentPort?.postMessage(checkModuleSync(input));
