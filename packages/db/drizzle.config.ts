import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit's view of the schema: `src/schema/*.ts` in, SQL and snapshots under `drizzle/` out.
 * `GRAFT_DATABASE_URL` is read from `apps/server/.env`, the one file that names the development
 * database for both the app and this CLI, so `db:push` and `pnpm run dev` cannot point at two
 * different Postgres instances. `generate`, `check` and `db:check-chain` need no database at all;
 * `push`, `migrate` and `studio` do, and fail with a sentence when the variable is unset.
 *
 * `drizzle-kit` is this package's dependency and not a root one — every root `db:*` script filters
 * to `@graft/db` for exactly that reason, and `pnpm exec drizzle-kit` at the repository root fails
 * with "command not found".
 */
dotenv.config({ path: "../../apps/server/.env", quiet: true });

export default defineConfig({
  schema: "./src/schema",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.GRAFT_DATABASE_URL ?? "",
  },
});
