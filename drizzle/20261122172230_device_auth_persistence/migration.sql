CREATE TYPE "device_status" AS ENUM('pending', 'approved', 'revoked');--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_expiry_after_creation" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "auth_sessions_revocation_after_creation" CHECK ("revoked_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"session_id" uuid NOT NULL,
	"previous_token_id" uuid,
	"token_hash" varchar(64) NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "refresh_tokens_hash_format" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "refresh_tokens_previous_not_self" CHECK ("previous_token_id" <> "id"),
	CONSTRAINT "refresh_tokens_expiry_after_creation" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "refresh_tokens_consumption_after_creation" CHECK ("consumed_at" >= "created_at")
);
--> statement-breakpoint
CREATE TABLE "user_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"label" varchar(100) NOT NULL,
	"credential_hash" varchar(64) NOT NULL UNIQUE,
	"status" "device_status" DEFAULT 'pending'::"device_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"approved_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "user_devices_label_nonblank" CHECK (btrim("label") <> ''),
	CONSTRAINT "user_devices_credential_hash_format" CHECK ("credential_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "user_devices_status_timestamps" CHECK (
      ("status" = 'pending' AND "approved_at" IS NULL AND "revoked_at" IS NULL)
      OR ("status" = 'approved' AND "approved_at" IS NOT NULL AND "revoked_at" IS NULL)
      OR ("status" = 'revoked' AND "revoked_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE INDEX "auth_sessions_device_owner_idx" ON "auth_sessions" ("user_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_session_id_uq" ON "refresh_tokens" ("session_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_previous_uq" ON "refresh_tokens" ("previous_token_id") WHERE "previous_token_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_session_root_uq" ON "refresh_tokens" ("session_id") WHERE "previous_token_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_session_unconsumed_uq" ON "refresh_tokens" ("session_id") WHERE "consumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "user_devices_owner_id_uq" ON "user_devices" ("user_id","id");--> statement-breakpoint
CREATE INDEX "user_devices_pending_idx" ON "user_devices" ("created_at") WHERE "status" = 'pending';--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_device_owner_fk" FOREIGN KEY ("user_id","device_id") REFERENCES "user_devices"("user_id","id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_session_id_auth_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id");--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_previous_session_fk" FOREIGN KEY ("session_id","previous_token_id") REFERENCES "refresh_tokens"("session_id","id");--> statement-breakpoint
ALTER TABLE "user_devices" ADD CONSTRAINT "user_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id");