-- GRA-204 (ADR 0024): a person's Setup record, one row per person, so the key is the person. The
-- step reached, the harness picked (null when Setup adopted an agent that already existed), and the
-- agent, the open connection ask, the connection, the acquire job and the tool it produced, each
-- `set null` on delete so the record outlives them; `skipped_at` and `completed_at` are what the
-- console's show rule reads.
CREATE TABLE "setup" (
	"person_id" text PRIMARY KEY NOT NULL,
	"step" text DEFAULT 'harness' NOT NULL,
	"harness" text,
	"agent_id" text,
	"pending_action_id" text,
	"connection_id" text,
	"acquire_job_id" text,
	"tool_id" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"skipped_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_pending_action_id_pending_action_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_action"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_acquire_job_id_acquire_job_id_fk" FOREIGN KEY ("acquire_job_id") REFERENCES "public"."acquire_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup" ADD CONSTRAINT "setup_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "setup_agent_id_idx" ON "setup" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "setup_pending_action_id_idx" ON "setup" USING btree ("pending_action_id");--> statement-breakpoint
CREATE INDEX "setup_connection_id_idx" ON "setup" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "setup_acquire_job_id_idx" ON "setup" USING btree ("acquire_job_id");--> statement-breakpoint
CREATE INDEX "setup_tool_id_idx" ON "setup" USING btree ("tool_id");