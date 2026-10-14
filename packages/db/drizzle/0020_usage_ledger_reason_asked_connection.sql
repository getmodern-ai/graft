ALTER TABLE "usage_ledger" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "asked" boolean;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD COLUMN "connection_id" text;--> statement-breakpoint
ALTER TABLE "usage_ledger" ADD CONSTRAINT "usage_ledger_connection_id_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_ledger_connection_id_idx" ON "usage_ledger" USING btree ("connection_id");