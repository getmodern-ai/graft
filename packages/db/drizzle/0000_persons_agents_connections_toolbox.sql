CREATE TABLE "acquire_job" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"progress" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"token_spend" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"trace_ref" text,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"working_set_cap" integer DEFAULT 20 NOT NULL,
	"idle_window_days" integer DEFAULT 21 NOT NULL,
	"revoked_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "agent_connection" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connection_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "approval" (
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"decision" text NOT NULL,
	"decided_at" timestamp NOT NULL,
	"per_call_relaxed" boolean DEFAULT false NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "approval_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "build_approval" (
	"agent_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"granted_at" timestamp DEFAULT now() NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "build_approval_agent_id_connection_id_pk" PRIMARY KEY("agent_id","connection_id")
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connection" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"vendor" text NOT NULL,
	"display_name" text NOT NULL,
	"scheme" text NOT NULL,
	"scheme_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"primary_host" text NOT NULL,
	"hosts" text[] NOT NULL,
	"credential_ciphertext" "bytea",
	"credential_set_at" timestamp,
	"oauth_client_id" text,
	"oauth_client_secret_ciphertext" "bytea",
	"oauth_authorize_url" text,
	"oauth_token_url" text,
	"oauth_scopes" text[],
	"oauth_refresh_state" jsonb,
	"revoked_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_action" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp NOT NULL,
	"answered_at" timestamp,
	"answer" jsonb,
	"consumed_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "authored_tool" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"vendor" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"current_version_id" text,
	"read_only" boolean NOT NULL,
	"destructive" boolean NOT NULL,
	"default_connection_id" text,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "authored_tool_person_id_vendor_name_unique" UNIQUE("person_id","vendor","name")
);
--> statement-breakpoint
CREATE TABLE "tool_version" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"path" text NOT NULL,
	"source_hash" text NOT NULL,
	"lockfile_hash" text,
	"check_output" jsonb NOT NULL,
	"dry_run_outcome" jsonb,
	"dry_run_at" timestamp,
	"writes_involved" boolean DEFAULT false NOT NULL,
	"publisher_job_id" text,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tool_version_tool_id_version_number_unique" UNIQUE("tool_id","version_number")
);
--> statement-breakpoint
CREATE TABLE "usage_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tool_id" text,
	"version_id" text,
	"tool_name" text NOT NULL,
	"outcome" text NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"latency_ms" integer NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "working_set" (
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"promoted_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"promoted_by" text NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "working_set_agent_id_tool_id_pk" PRIMARY KEY("agent_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "working_set_change" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"change" text NOT NULL,
	"cause" text NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "acquire_job" ADD CONSTRAINT "acquire_job_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD CONSTRAINT "acquire_job_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection" ADD CONSTRAINT "agent_connection_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection" ADD CONSTRAINT "agent_connection_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_approval" ADD CONSTRAINT "build_approval_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "build_approval" ADD CONSTRAINT "build_approval_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection" ADD CONSTRAINT "connection_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_action" ADD CONSTRAINT "pending_action_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authored_tool" ADD CONSTRAINT "authored_tool_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authored_tool" ADD CONSTRAINT "authored_tool_current_version_id_tool_version_id_fk" FOREIGN KEY ("current_version_id") REFERENCES "public"."tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authored_tool" ADD CONSTRAINT "authored_tool_default_connection_id_connection_id_fk" FOREIGN KEY ("default_connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_version" ADD CONSTRAINT "tool_version_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_version" ADD CONSTRAINT "tool_version_publisher_job_id_acquire_job_id_fk" FOREIGN KEY ("publisher_job_id") REFERENCES "public"."acquire_job"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_version_id_tool_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_set" ADD CONSTRAINT "working_set_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_set" ADD CONSTRAINT "working_set_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_set_change" ADD CONSTRAINT "working_set_change_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "working_set_change" ADD CONSTRAINT "working_set_change_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquire_job_agent_id_idx" ON "acquire_job" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "acquire_job_connection_id_idx" ON "acquire_job" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "agent_person_id_idx" ON "agent" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "agent_connection_connection_id_idx" ON "agent_connection" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "approval_tool_id_idx" ON "approval" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "build_approval_connection_id_idx" ON "build_approval" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_accountId_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "connection_person_id_idx" ON "connection" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "connection_person_id_vendor_idx" ON "connection" USING btree ("person_id","vendor");--> statement-breakpoint
CREATE INDEX "pending_action_agent_id_idx" ON "pending_action" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "authored_tool_person_id_idx" ON "authored_tool" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "authored_tool_current_version_id_idx" ON "authored_tool" USING btree ("current_version_id");--> statement-breakpoint
CREATE INDEX "authored_tool_default_connection_id_idx" ON "authored_tool" USING btree ("default_connection_id");--> statement-breakpoint
CREATE INDEX "tool_version_tool_id_idx" ON "tool_version" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "tool_version_publisher_job_id_idx" ON "tool_version" USING btree ("publisher_job_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_agent_id_created_at_idx" ON "usage_ledger" USING btree ("agent_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "usage_ledger_tool_id_idx" ON "usage_ledger" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "usage_ledger_version_id_idx" ON "usage_ledger" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX "working_set_tool_id_idx" ON "working_set" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "working_set_agent_id_last_used_at_idx" ON "working_set" USING btree ("agent_id","last_used_at");--> statement-breakpoint
CREATE INDEX "working_set_change_agent_id_idx" ON "working_set_change" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "working_set_change_tool_id_idx" ON "working_set_change" USING btree ("tool_id");