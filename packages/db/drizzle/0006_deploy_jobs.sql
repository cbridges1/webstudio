CREATE TYPE "public"."DeployJobKind" AS ENUM('publish', 'unpublish', 'validate');--> statement-breakpoint
CREATE TYPE "public"."DeployJobStatus" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "DeployJob" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text DEFAULT 'default' NOT NULL,
	"kind" "DeployJobKind" NOT NULL,
	"projectId" text NOT NULL,
	"buildId" text,
	"request" jsonb NOT NULL,
	"status" "DeployJobStatus" DEFAULT 'queued' NOT NULL,
	"error" text,
	"result" jsonb,
	"attempts" integer DEFAULT 0 NOT NULL,
	"workerId" text,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"startedAt" timestamp(3) with time zone,
	"heartbeatAt" timestamp(3) with time zone,
	"finishedAt" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "DeploySettings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wakeUrl" text,
	"wakeToken" text,
	"builderUrl" text,
	"updatedAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "DeployWorker" (
	"id" text PRIMARY KEY NOT NULL,
	"queue" text DEFAULT 'default' NOT NULL,
	"hosts" jsonb NOT NULL,
	"startedAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"seenAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "DeployJob" ADD CONSTRAINT "DeployJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "DeployJob_queue_status_createdAt_idx" ON "DeployJob" USING btree ("queue","status","createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "DeploySettings_single_key" ON "DeploySettings" USING btree ((true));--> statement-breakpoint
-- The builder address an admin saved for the old deployer still applies.
INSERT INTO "DeploySettings" ("builderUrl")
	SELECT "builderUrl" FROM "Deployer" WHERE "builderUrl" IS NOT NULL LIMIT 1;--> statement-breakpoint
DROP TABLE "Deployer" CASCADE;