import type { Database } from "@graft/db";
import { drizzle } from "drizzle-orm/node-postgres";

import { createAuth } from "./src/index";

/**
 * The Better Auth CLI's entry point, for `pnpm --filter @graft/auth generate-schema`: the CLI reads
 * an `auth` export and writes the drizzle schema its configuration needs to
 * `packages/db/src/schema/auth.ts`. Nothing here connects — drizzle opens a pool lazily and the
 * generator never queries — so the URL and the secret are placeholders, not configuration.
 *
 * A bare `drizzle(url)` rather than `@graft/db`'s `createDb`, deliberately: `createDb` loads the
 * whole schema, whose `agent.person_id` references the very `user` table this run is about to
 * write, so on a fresh checkout or after deleting the generated file it cannot load. The adapter
 * only needs the provider to generate.
 */
export const auth = createAuth({
  db: drizzle("postgresql://schema-generation-only@localhost:5432/unused") as unknown as Database,
  secret: "schema-generation-only-placeholder-secret-32",
  baseURL: "http://localhost:3000",
});
