ALTER TABLE "connection" ADD COLUMN "account" text;--> statement-breakpoint
ALTER TABLE "pending_action" ADD COLUMN "asked_count" integer DEFAULT 1 NOT NULL;