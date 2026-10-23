CREATE TABLE "Deployer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspaceId" uuid NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"apiKey" text NOT NULL,
	"builderUrl" text,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ProjectDeployTarget" (
	"projectId" text PRIMARY KEY NOT NULL,
	"deployerId" uuid NOT NULL,
	"host" text NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text,
	"updatedAt" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Deployer" ADD CONSTRAINT "Deployer_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ProjectDeployTarget" ADD CONSTRAINT "ProjectDeployTarget_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ProjectDeployTarget" ADD CONSTRAINT "ProjectDeployTarget_deployerId_fkey" FOREIGN KEY ("deployerId") REFERENCES "public"."Deployer"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "Deployer_workspaceId_idx" ON "Deployer" USING btree ("workspaceId");--> statement-breakpoint
CREATE INDEX "ProjectDeployTarget_deployerId_idx" ON "ProjectDeployTarget" USING btree ("deployerId");