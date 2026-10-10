-- GRA-245 (ADR 0008): an approval records the tool version it was given for, so a republished write
-- tool asks again once and a new stock version that does not widen carries the answer forward.
-- Every existing answer is taken as given for its tool's current version: nothing asks again on
-- upgrade. Null after this reads as no version, which asks.
ALTER TABLE "approval" ADD COLUMN "tool_version_id" text;--> statement-breakpoint
ALTER TABLE "approval" ADD CONSTRAINT "approval_tool_version_id_tool_version_id_fk" FOREIGN KEY ("tool_version_id") REFERENCES "public"."tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_tool_version_id_idx" ON "approval" USING btree ("tool_version_id");--> statement-breakpoint
UPDATE "approval" SET "tool_version_id" = "authored_tool"."current_version_id" FROM "authored_tool" WHERE "authored_tool"."id" = "approval"."tool_id";
