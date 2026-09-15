ALTER TABLE "approval" ADD COLUMN "ask_every_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "approval" DROP COLUMN "per_call_relaxed";