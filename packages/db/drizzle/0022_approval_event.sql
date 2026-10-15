CREATE TABLE "approval_event" (
	"id" text PRIMARY KEY NOT NULL,
	"person_id" text NOT NULL,
	"agent_id" text,
	"kind" text NOT NULL,
	"action" text NOT NULL,
	"tool_id" text,
	"vendor" text,
	"connection_id" text,
	"includes_destructive" boolean,
	"via" text NOT NULL,
	"pending_action_id" text,
	"at" timestamp NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_event" ADD CONSTRAINT "approval_event_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_event" ADD CONSTRAINT "approval_event_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_event" ADD CONSTRAINT "approval_event_tool_id_authored_tool_id_fk" FOREIGN KEY ("tool_id") REFERENCES "public"."authored_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_event" ADD CONSTRAINT "approval_event_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_event" ADD CONSTRAINT "approval_event_pending_action_id_pending_action_id_fk" FOREIGN KEY ("pending_action_id") REFERENCES "public"."pending_action"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_event_person_id_at_idx" ON "approval_event" USING btree ("person_id","at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "approval_event_agent_id_idx" ON "approval_event" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "approval_event_tool_id_idx" ON "approval_event" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "approval_event_connection_id_idx" ON "approval_event" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "approval_event_pending_action_id_idx" ON "approval_event" USING btree ("pending_action_id");