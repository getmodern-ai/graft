-- GRA-243 (ADR 0025): the tool a remix starts from. `acquire` with `from` records the tool whose
-- current module the job hands its model and onto which it publishes; null for a new tool.
ALTER TABLE "acquire_job" ADD COLUMN "from_tool_id" text;--> statement-breakpoint
ALTER TABLE "acquire_job" ADD CONSTRAINT "acquire_job_from_tool_id_authored_tool_id_fk" FOREIGN KEY ("from_tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "acquire_job_from_tool_id_idx" ON "acquire_job" USING btree ("from_tool_id");