CREATE TABLE "relay_call_count" (
	"agent_id" text NOT NULL,
	"person_id" text NOT NULL,
	"hour_start" timestamp NOT NULL,
	"calls" integer NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "relay_call_count_agent_id_hour_start_pk" PRIMARY KEY("agent_id","hour_start")
);
--> statement-breakpoint
ALTER TABLE "relay_call_count" ADD CONSTRAINT "relay_call_count_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_call_count" ADD CONSTRAINT "relay_call_count_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_call_count_person_id_hour_start_idx" ON "relay_call_count" USING btree ("person_id","hour_start");--> statement-breakpoint
CREATE INDEX "relay_call_count_hour_start_idx" ON "relay_call_count" USING btree ("hour_start");