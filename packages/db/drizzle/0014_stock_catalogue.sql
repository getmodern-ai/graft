-- GRA-238 (ADR 0025): the stock catalogue, global and person-free. One row per (vendor, name) and
-- its versions, appended by number when the workspace's source hash changes and never edited, each
-- carrying the definition, the hosts, the module's files and the check's result. A person's copy
-- records its stock origin on tool_version (stock_tool_id, stock_version_id), set null on delete.
CREATE TABLE "stock_tool" (
	"id" text PRIMARY KEY NOT NULL,
	"vendor" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_tool_vendor_name_unique" UNIQUE("vendor","name")
);
--> statement-breakpoint
CREATE TABLE "stock_tool_version" (
	"id" text PRIMARY KEY NOT NULL,
	"stock_tool_id" text NOT NULL,
	"version_number" integer NOT NULL,
	"source_hash" text NOT NULL,
	"description" text NOT NULL,
	"input_schema" jsonb NOT NULL,
	"read_only" boolean NOT NULL,
	"destructive" boolean NOT NULL,
	"hosts" text[] NOT NULL,
	"files" jsonb NOT NULL,
	"test_input" jsonb NOT NULL,
	"check_output" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "stock_tool_version_stock_tool_id_version_number_unique" UNIQUE("stock_tool_id","version_number")
);
--> statement-breakpoint
ALTER TABLE "tool_version" ADD COLUMN "stock_tool_id" text;--> statement-breakpoint
ALTER TABLE "tool_version" ADD COLUMN "stock_version_id" text;--> statement-breakpoint
ALTER TABLE "stock_tool_version" ADD CONSTRAINT "stock_tool_version_stock_tool_id_stock_tool_id_fk" FOREIGN KEY ("stock_tool_id") REFERENCES "public"."stock_tool"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_tool_version_stock_tool_id_idx" ON "stock_tool_version" USING btree ("stock_tool_id");--> statement-breakpoint
ALTER TABLE "tool_version" ADD CONSTRAINT "tool_version_stock_tool_id_stock_tool_id_fk" FOREIGN KEY ("stock_tool_id") REFERENCES "public"."stock_tool"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_version" ADD CONSTRAINT "tool_version_stock_version_id_stock_tool_version_id_fk" FOREIGN KEY ("stock_version_id") REFERENCES "public"."stock_tool_version"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tool_version_stock_tool_id_idx" ON "tool_version" USING btree ("stock_tool_id");--> statement-breakpoint
CREATE INDEX "tool_version_stock_version_id_idx" ON "tool_version" USING btree ("stock_version_id");