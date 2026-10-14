CREATE TABLE "vendor_approval" (
	"agent_id" text NOT NULL,
	"vendor" text NOT NULL,
	"includes_destructive" boolean DEFAULT false NOT NULL,
	"granted_at" timestamp NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "vendor_approval_agent_id_vendor_pk" PRIMARY KEY("agent_id","vendor")
);
--> statement-breakpoint
ALTER TABLE "vendor_approval" ADD CONSTRAINT "vendor_approval_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;