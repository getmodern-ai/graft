-- GRA-105 (ADR 0007 as amended 2026-09-19): an agent's scope is `all` -- every connection of the
-- person's, present and future -- or `listed`, the rows in `agent_connection`. New rows default to
-- `all`; every row that exists when this runs is what `listed` names, so the column is added with
-- `listed` as its default (which is what the existing rows read) and the default is moved to `all`
-- afterwards, for the rows made from here on. The snapshot records the final default only, which
-- is why `db:generate` produces nothing on top of this file.
ALTER TABLE "agent" ADD COLUMN "scope_mode" text DEFAULT 'listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "scope_mode" SET DEFAULT 'all';
