CREATE TYPE "public"."AuthorizationRelation" AS ENUM('viewers', 'editors', 'builders', 'administrators');--> statement-breakpoint
CREATE TYPE "public"."DomainStatus" AS ENUM('INITIALIZING', 'ACTIVE', 'ERROR', 'PENDING');--> statement-breakpoint
CREATE TYPE "public"."MarketplaceApprovalStatus" AS ENUM('UNLISTED', 'PENDING', 'APPROVED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."PublishStatus" AS ENUM('PENDING', 'PUBLISHED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."UploadStatus" AS ENUM('UPLOADING', 'UPLOADED');--> statement-breakpoint
CREATE TABLE "Asset" (
	"id" text NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"filename" text,
	"folderId" text,
	CONSTRAINT "Asset_pkey" PRIMARY KEY("id","projectId")
);
--> statement-breakpoint
CREATE TABLE "AssetFileMetadata" (
	"projectId" text NOT NULL,
	"assetId" text NOT NULL,
	"revision" text NOT NULL,
	"document" jsonb NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "AssetFileMetadata_pkey" PRIMARY KEY("projectId","assetId"),
	CONSTRAINT "AssetFileMetadata_document_identity_check" CHECK (((((jsonb_typeof(document) = 'object'::text) AND (jsonb_typeof((document -> '_id'::text)) = 'string'::text) AND ((document ->> '_id'::text) = "assetId") AND (jsonb_typeof((document -> 'revision'::text)) = 'string'::text) AND ((document ->> 'revision'::text) = revision)) IS TRUE)))
);
--> statement-breakpoint
CREATE TABLE "AssetFolder" (
	"id" text DEFAULT gen_random_uuid() NOT NULL,
	"projectId" text NOT NULL,
	"name" text NOT NULL,
	"parentId" text,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "AssetFolder_pkey" PRIMARY KEY("id","projectId"),
	CONSTRAINT "AssetFolder_name_not_blank" CHECK ((btrim(name) <> ''::text))
);
--> statement-breakpoint
CREATE TABLE "AuthorizationToken" (
	"token" text NOT NULL,
	"projectId" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"relation" "AuthorizationRelation" DEFAULT 'viewers' NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"canClone" boolean DEFAULT true NOT NULL,
	"canCopy" boolean DEFAULT true NOT NULL,
	"canPublish" boolean DEFAULT false NOT NULL,
	"canUseApi" boolean DEFAULT false NOT NULL,
	CONSTRAINT "AuthorizationToken_pkey" PRIMARY KEY("token","projectId")
);
--> statement-breakpoint
CREATE TABLE "Build" (
	"id" text NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"pages" text NOT NULL,
	"projectId" text NOT NULL,
	"styleSources" text DEFAULT '[]' NOT NULL,
	"styles" text DEFAULT '[]' NOT NULL,
	"breakpoints" text DEFAULT '[]' NOT NULL,
	"styleSourceSelections" text DEFAULT '[]' NOT NULL,
	"props" text DEFAULT '[]' NOT NULL,
	"instances" text DEFAULT '[]' NOT NULL,
	"updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"deployment" text,
	"publishStatus" "PublishStatus" DEFAULT 'PENDING' NOT NULL,
	"dataSources" text DEFAULT '[]' NOT NULL,
	"lastTransactionId" text,
	"resources" text DEFAULT '[]' NOT NULL,
	"marketplaceProduct" text DEFAULT '{}' NOT NULL,
	"isCleaned" boolean DEFAULT false,
	"projectSettings" text DEFAULT '{"meta":{},"compiler":{}}' NOT NULL,
	CONSTRAINT "Build_pkey" PRIMARY KEY("id","projectId")
);
--> statement-breakpoint
CREATE TABLE "ClientReferences" (
	"reference" text DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"userId" text NOT NULL,
	CONSTRAINT "ClientReferences_pkey" PRIMARY KEY("userId","service")
);
--> statement-breakpoint
CREATE TABLE "Domain" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"txtRecord" text,
	"status" "DomainStatus" DEFAULT 'INITIALIZING' NOT NULL,
	"error" text,
	"updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "File" (
	"name" text PRIMARY KEY NOT NULL,
	"format" text NOT NULL,
	"size" integer NOT NULL,
	"description" text,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"status" "UploadStatus" DEFAULT 'UPLOADING' NOT NULL,
	"uploaderProjectId" text,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"contentHash" varchar(64)
);
--> statement-breakpoint
CREATE TABLE "Notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"recipientId" text NOT NULL,
	"senderId" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"respondedAt" timestamp(3) with time zone
);
--> statement-breakpoint
CREATE TABLE "Product" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"features" text[],
	"images" text[],
	"meta" jsonb NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Project" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"domain" text NOT NULL,
	"userId" text,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"previewImageAssetId" text,
	"marketplaceApprovalStatus" "MarketplaceApprovalStatus" DEFAULT 'UNLISTED' NOT NULL,
	"tags" text[],
	"workspaceId" uuid
);
--> statement-breakpoint
CREATE TABLE "ProjectDomain" (
	"projectId" text NOT NULL,
	"domainId" text NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"txtRecord" text NOT NULL,
	"cname" text NOT NULL,
	CONSTRAINT "ProjectDomain_pkey" PRIMARY KEY("projectId","domainId")
);
--> statement-breakpoint
CREATE TABLE "TransactionLog" (
	"eventId" text PRIMARY KEY NOT NULL,
	"productId" text,
	"userId" text,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"eventData" jsonb,
	"eventCreated" integer GENERATED ALWAYS AS ((("eventData" #>> '{created}'::text[]))::integer) STORED,
	"eventType" text GENERATED ALWAYS AS (("eventData" #>> '{type}'::text[])) STORED,
	"status" text GENERATED ALWAYS AS (("eventData" #>> '{data,object,status}'::text[])) STORED,
	"customerId" text GENERATED ALWAYS AS (("eventData" #>> '{data,object,customer}'::text[])) STORED,
	"customerEmail" text GENERATED ALWAYS AS (("eventData" #>> '{data,object,customer_details,email}'::text[])) STORED,
	"subscriptionId" text GENERATED ALWAYS AS (CASE WHEN (("eventData" #>> '{data,object,object}'::text[]) = 'subscription'::text) THEN ("eventData" #>> '{data,object,id}'::text[]) ELSE ("eventData" #>> '{data,object,subscription}'::text[]) END) STORED,
	"paymentIntent" text GENERATED ALWAYS AS (("eventData" #>> '{data,object,payment_intent}'::text[])) STORED
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" text PRIMARY KEY NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"email" text,
	"image" text,
	"provider" text,
	"username" text,
	"projectsTags" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"isDefault" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"userId" text NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WorkspaceMember" (
	"workspaceId" uuid NOT NULL,
	"userId" text NOT NULL,
	"relation" "AuthorizationRelation" DEFAULT 'administrators' NOT NULL,
	"createdAt" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"removedAt" timestamp(3) with time zone,
	CONSTRAINT "WorkspaceMember_pkey" PRIMARY KEY("workspaceId","userId")
);
--> statement-breakpoint
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_name_fkey" FOREIGN KEY ("name") REFERENCES "public"."File"("name") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Asset" ADD CONSTRAINT "Asset_folderId_projectId_fkey" FOREIGN KEY ("folderId","projectId") REFERENCES "public"."AssetFolder"("id","projectId") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AssetFileMetadata" ADD CONSTRAINT "AssetFileMetadata_assetId_projectId_fkey" FOREIGN KEY ("assetId","projectId") REFERENCES "public"."Asset"("id","projectId") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AssetFolder" ADD CONSTRAINT "AssetFolder_parentId_projectId_fkey" FOREIGN KEY ("parentId","projectId") REFERENCES "public"."AssetFolder"("id","projectId") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AuthorizationToken" ADD CONSTRAINT "AuthorizationToken_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Build" ADD CONSTRAINT "Build_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ClientReferences" ADD CONSTRAINT "ClientReferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "File" ADD CONSTRAINT "File_uploaderProjectId_fkey" FOREIGN KEY ("uploaderProjectId") REFERENCES "public"."Project"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_previewImageAssetId_id_fkey" FOREIGN KEY ("previewImageAssetId","id") REFERENCES "public"."Asset"("id","projectId") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ProjectDomain" ADD CONSTRAINT "ProjectDomain_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ProjectDomain" ADD CONSTRAINT "ProjectDomain_domainId_fkey" FOREIGN KEY ("domainId") REFERENCES "public"."Domain"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TransactionLog" ADD CONSTRAINT "TransactionLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "public"."Product"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "TransactionLog" ADD CONSTRAINT "TransactionLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "public"."Workspace"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "WorkspaceMember" ADD CONSTRAINT "WorkspaceMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "AssetFolder_projectId_parentId_idx" ON "AssetFolder" USING btree ("projectId","parentId");--> statement-breakpoint
CREATE UNIQUE INDEX "AssetFolder_unique_sibling_name" ON "AssetFolder" USING btree ("projectId",COALESCE("parentId", ''::text),lower(btrim(name)));--> statement-breakpoint
CREATE UNIQUE INDEX "AuthorizationToken_token_key" ON "AuthorizationToken" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "Build_id_key" ON "Build" USING btree ("id");--> statement-breakpoint
CREATE UNIQUE INDEX "Build_dev_index" ON "Build" USING btree ("projectId") WHERE (deployment IS NULL);--> statement-breakpoint
CREATE INDEX "Build_projectId_createdAt_idx" ON "Build" USING btree ("projectId","createdAt" DESC NULLS FIRST);--> statement-breakpoint
CREATE UNIQUE INDEX "ClientReferences_reference_service_key" ON "ClientReferences" USING btree ("reference","service");--> statement-breakpoint
CREATE UNIQUE INDEX "Domain_domain_key" ON "Domain" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "File_uploaderProjectId_contentHash_extension_key" ON "File" USING btree ("uploaderProjectId","contentHash",(CASE WHEN ((strpos(reverse(name), '.'::text) = ANY (ARRAY[0, 1])) OR (((length(name) - strpos(reverse(name), '.'::text)) + 1) = 1)) THEN ''::text ELSE lower(reverse(split_part(reverse(name), '.'::text, 1))) END)) WHERE ("contentHash" IS NOT NULL);--> statement-breakpoint
CREATE INDEX "Notification_recipientId_status_idx" ON "Notification" USING btree ("recipientId","status");--> statement-breakpoint
CREATE UNIQUE INDEX "Project_domain_isDeleted_key" ON "Project" USING btree ("domain","isDeleted");--> statement-breakpoint
CREATE UNIQUE INDEX "Project_domain_key" ON "Project" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "Project_id_domain_key" ON "Project" USING btree ("id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "Project_id_isDeleted_key" ON "Project" USING btree ("id","isDeleted");--> statement-breakpoint
CREATE INDEX "Project_isDeleted_marketplaceApprovalStatus_idx" ON "Project" USING btree ("isDeleted","marketplaceApprovalStatus");--> statement-breakpoint
CREATE INDEX "ProjectDomain_domainId_idx" ON "ProjectDomain" USING btree ("domainId");--> statement-breakpoint
CREATE UNIQUE INDEX "ProjectDomain_txtRecord_key" ON "ProjectDomain" USING btree ("txtRecord");--> statement-breakpoint
CREATE UNIQUE INDEX "TransactionLog_eventId_productId_key" ON "TransactionLog" USING btree ("eventId","productId");--> statement-breakpoint
CREATE UNIQUE INDEX "User_email_key" ON "User" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "Workspace_userId_isDefault_key" ON "Workspace" USING btree ("userId","isDefault") WHERE ("isDefault" = true);--> statement-breakpoint
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember" USING btree ("userId");--> statement-breakpoint
CREATE VIEW "public"."ApprovedMarketplaceProduct" AS (SELECT DISTINCT ON (build."projectId") build."projectId", build."marketplaceProduct", ( SELECT auth.token FROM "AuthorizationToken" auth WHERE auth."projectId" = build."projectId" AND auth.relation = 'viewers'::"AuthorizationRelation" ORDER BY auth.token LIMIT 1) AS "authorizationToken" FROM "Build" build WHERE build.deployment IS NOT NULL AND (build."projectId" IN ( SELECT "Project".id FROM "Project" WHERE "Project"."isDeleted" = false AND "Project"."marketplaceApprovalStatus" = 'APPROVED'::text::"MarketplaceApprovalStatus")) ORDER BY build."projectId", build."createdAt" DESC, build.id);--> statement-breakpoint
CREATE VIEW "public"."DashboardProject" AS (SELECT "Project".id, "Project".title, "Project".tags, "Project".domain, "Project"."userId", "Project"."workspaceId", "Project"."isDeleted", "Project"."createdAt", "Project"."previewImageAssetId", "Project"."marketplaceApprovalStatus", (EXISTS ( SELECT 1 FROM "Build" WHERE "Build"."projectId" = "Project".id AND "Build".deployment IS NOT NULL)) AS "isPublished" FROM "Project");--> statement-breakpoint
CREATE VIEW "public"."LatestStaticBuildPerProject" AS (SELECT DISTINCT ON (bld."projectId") bld.id AS "buildId", bld."projectId", bld."updatedAt", bld."publishStatus" FROM "Build" bld WHERE bld.deployment IS NOT NULL AND (bld.deployment::jsonb ->> 'destination'::text) = 'static'::text ORDER BY bld."projectId", bld."createdAt" DESC, bld.id);--> statement-breakpoint
CREATE VIEW "public"."published_builds" AS (SELECT build.id AS "buildId", build."projectId", build."createdAt", ( SELECT string_agg(list.value, ', '::text) AS string_agg FROM jsonb_array_elements_text(build.deployment::jsonb -> 'domains'::text) list(value)) AS domains FROM "Build" build WHERE build.deployment IS NOT NULL AND build."isCleaned" = false ORDER BY build."projectId", build."createdAt" DESC);--> statement-breakpoint
CREATE VIEW "public"."UserProduct" AS (( SELECT tl."userId", tl."subscriptionId", tl."productId", tl."customerId", tl."customerEmail" FROM "TransactionLog" tl WHERE tl.status = 'complete'::text AND tl."eventType" = 'checkout.session.completed'::text AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" failed WHERE failed."eventType" = 'checkout.session.async_payment_failed'::text AND (failed."eventData" #>> '{data,object,id}'::text[]) = (tl."eventData" #>> '{data,object,id}'::text[]) AND failed."eventCreated" >= tl."eventCreated")) AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" tlexsists WHERE tlexsists."subscriptionId" = tl."subscriptionId" AND tlexsists."eventType" = 'customer.subscription.deleted'::text AND tlexsists.status = 'canceled'::text AND tlexsists."eventCreated" > tl."eventCreated")) AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" tlexsists WHERE tlexsists."paymentIntent" = tl."paymentIntent" AND tlexsists."eventType" = 'charge.refunded'::text AND tlexsists.status = 'succeeded'::text AND tlexsists."eventCreated" > tl."eventCreated")) ORDER BY tl."userId", tl."eventCreated" DESC) UNION ALL SELECT "TransactionLog"."userId", "TransactionLog"."subscriptionId", "TransactionLog"."productId", "TransactionLog"."customerId", "TransactionLog"."customerEmail" FROM "TransactionLog" WHERE "TransactionLog"."eventType" = 'appsumo.activate'::text);--> statement-breakpoint
CREATE VIEW "public"."user_publish_count" AS (SELECT DISTINCT "Project"."userId" AS user_id, count(*) AS count FROM "Build" LEFT JOIN "Project" ON "Project".id = "Build"."projectId" WHERE date_trunc('day'::text, "Build"."createdAt") = date_trunc('day'::text, now()) AND "Build".deployment IS NOT NULL GROUP BY "Project"."userId");--> statement-breakpoint
CREATE VIEW "public"."WorkspaceProjectAuthorization" AS (SELECT w."userId", p.id AS "projectId", 'own'::text AS relation FROM "Workspace" w JOIN "Project" p ON p."workspaceId" = w.id WHERE w."isDeleted" = false AND p."isDeleted" = false UNION ALL SELECT wm."userId", p.id AS "projectId", wm.relation::text AS relation FROM "WorkspaceMember" wm JOIN "Workspace" w ON w.id = wm."workspaceId" JOIN "Project" p ON p."workspaceId" = wm."workspaceId" WHERE wm."removedAt" IS NULL AND w."isDeleted" = false AND p."isDeleted" = false);