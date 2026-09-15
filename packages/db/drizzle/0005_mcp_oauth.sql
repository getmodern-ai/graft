CREATE TABLE "mcp_authorization_code" (
	"id" text PRIMARY KEY NOT NULL,
	"code_hash" text NOT NULL,
	"client_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text NOT NULL,
	"resource" text,
	"scope" text,
	"expires_at" timestamp NOT NULL,
	"consumed_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_authorization_code_code_hash_unique" UNIQUE("code_hash")
);
--> statement-breakpoint
CREATE TABLE "mcp_client" (
	"id" text PRIMARY KEY NOT NULL,
	"secret_hash" text,
	"name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'client_secret_basic' NOT NULL,
	"grant_types" text[] NOT NULL,
	"response_types" text[] NOT NULL,
	"scope" text,
	"client_uri" text,
	"logo_uri" text,
	"software_id" text,
	"software_version" text,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_token" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"kind" text NOT NULL,
	"client_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"grant_id" text NOT NULL,
	"resource" text,
	"scope" text,
	"expires_at" timestamp,
	"rotated_at" timestamp,
	"revoked_at" timestamp,
	"owner" text DEFAULT 'person' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ALTER COLUMN "token_prefix" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "connected_via_client_id" text;--> statement-breakpoint
ALTER TABLE "agent" ADD COLUMN "connected_via_client_name" text;--> statement-breakpoint
ALTER TABLE "mcp_authorization_code" ADD CONSTRAINT "mcp_authorization_code_client_id_mcp_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_authorization_code" ADD CONSTRAINT "mcp_authorization_code_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_client_id_mcp_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."mcp_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_token" ADD CONSTRAINT "mcp_token_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_authorization_code_client_id_idx" ON "mcp_authorization_code" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_authorization_code_agent_id_idx" ON "mcp_authorization_code" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_token_client_id_idx" ON "mcp_token" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mcp_token_agent_id_idx" ON "mcp_token" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "mcp_token_grant_id_idx" ON "mcp_token" USING btree ("grant_id");--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_connected_via_client_id_mcp_client_id_fk" FOREIGN KEY ("connected_via_client_id") REFERENCES "public"."mcp_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_connected_via_client_id_idx" ON "agent" USING btree ("connected_via_client_id");