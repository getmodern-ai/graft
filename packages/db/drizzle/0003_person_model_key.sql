CREATE TABLE "person_model_key" (
	"person_id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"authoring_model" text,
	"triage_model" text,
	"base_url" text,
	"key_ciphertext" "bytea" NOT NULL,
	"key_set_at" timestamp NOT NULL,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "person_model_key" ADD CONSTRAINT "person_model_key_person_id_user_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;