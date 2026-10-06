-- GRA-186 (ADR 0023): one row per blob a tool wrote, written by the server from the ledger the
-- runner returns beside a run's result. `id` is the blob id inside `blob://<id>`; the person and the
-- agent are both on the row so every read names the pair (ADR 0007); `removed_at` is set by the sweep
-- (GRA-189) and the row stays, so the door can say expired rather than not found.
CREATE TABLE "blob" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"version_id" text,
	"bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"name" text,
	"expires_at" timestamp NOT NULL,
	"removed_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "blob" ADD CONSTRAINT "blob_version_id_tool_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_person_id_idx" ON "blob" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "blob_agent_id_expires_at_idx" ON "blob" USING btree ("agent_id","expires_at");--> statement-breakpoint
CREATE INDEX "blob_version_id_idx" ON "blob" USING btree ("version_id");