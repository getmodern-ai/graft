CREATE TABLE "acquire_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"attempt_number" integer NOT NULL,
	"draft_path" text NOT NULL,
	"files" jsonb NOT NULL,
	"check_output" jsonb,
	"version_id" text,
	"diagnosis" text,
	"outcome" text DEFAULT 'running' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"finished_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "acquire_attempt_job_id_attempt_number_unique" UNIQUE("job_id","attempt_number")
);
--> statement-breakpoint
CREATE TABLE "acquire_trace" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"attempt_number" integer,
	"sequence" integer NOT NULL,
	"kind" text NOT NULL,
	"text" text NOT NULL,
	"data" jsonb,
	"redacted" boolean DEFAULT false NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "acquire_trace_job_id_sequence_unique" UNIQUE("job_id","sequence")
);
--> statement-breakpoint
ALTER TABLE "acquire_job" ADD COLUMN "hints" text;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD COLUMN "heartbeat_at" timestamp;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD COLUMN "finished_at" timestamp;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD COLUMN "tool_id" text;--> statement-breakpoint
ALTER TABLE "acquire_attempt" ADD CONSTRAINT "acquire_attempt_job_id_acquire_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."acquire_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquire_attempt" ADD CONSTRAINT "acquire_attempt_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquire_attempt" ADD CONSTRAINT "acquire_attempt_version_id_tool_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquire_trace" ADD CONSTRAINT "acquire_trace_job_id_acquire_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."acquire_job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquire_trace" ADD CONSTRAINT "acquire_trace_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquire_attempt_job_id_idx" ON "acquire_attempt" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "acquire_attempt_agent_id_idx" ON "acquire_attempt" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "acquire_attempt_version_id_idx" ON "acquire_attempt" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "acquire_trace_job_id_idx" ON "acquire_trace" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "acquire_trace_agent_id_idx" ON "acquire_trace" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "acquire_job" ADD CONSTRAINT "acquire_job_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquire_job_tool_id_idx" ON "acquire_job" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "acquire_job_status_heartbeat_at_idx" ON "acquire_job" USING btree ("status","heartbeat_at");