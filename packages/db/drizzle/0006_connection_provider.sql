ALTER TABLE "connection" ADD COLUMN "provider" text DEFAULT 'keyring' NOT NULL;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "provider_ref" text;