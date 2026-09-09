import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";

import { describeEnvIssues, finalServerSchema, serverSchema } from "./schema";

/**
 * The validated server environment — import `env` from here rather than reading `process.env`, so
 * an unvalidated key crashes at boot instead of at first use. The rules are `schema.ts`'s, and are
 * tested there without this module's import-time side effect. `SKIP_ENV_VALIDATION=1` bypasses
 * validation for tooling that imports the module without a configured environment; the values are
 * then whatever `process.env` holds, unparsed.
 *
 * A refusal is one block on stderr, one line per problem with the variable named, then exit 1 — the
 * shape a `docker compose up` that forgot a secret shows (GRA-33), rather than the library's default
 * of a JSON dump and a stack trace.
 */
export const env = createEnv({
  server: serverSchema,
  createFinalSchema: (shape) => finalServerSchema(shape),
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
  onValidationError: (issues) => {
    console.error(
      `graft refused to start: the environment is invalid.\n\n${describeEnvIssues(issues)}\n\n` +
        "Every variable is documented in packages/env/src/schema.ts; the self-hosted form's are in README.md under Self-hosting.",
    );
    process.exit(1);
  },
});

export type ServerEnv = typeof env;
