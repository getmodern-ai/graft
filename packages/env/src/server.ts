import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import { finalServerSchema, serverSchema } from "./schema";

/**
 * The validated server environment — import `env` from here rather than reading `process.env`, so
 * an unvalidated key crashes at boot instead of at first use. The rules are `schema.ts`'s, and are
 * tested there without this module's import-time side effect. `SKIP_ENV_VALIDATION=1` bypasses
 * validation for tooling that imports the module without a configured environment; the values are
 * then whatever `process.env` holds, unparsed.
 */
export const env = createEnv({
  server: serverSchema,
  createFinalSchema: (shape) => finalServerSchema(shape),
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});

export type ServerEnv = typeof env;
