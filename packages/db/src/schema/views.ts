import { sql } from "drizzle-orm";
import { bigint, boolean, pgView, text, uuid } from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";
import { marketplaceApprovalStatus, publishStatus } from "./enums";

// View definitions are kept as upstream wrote them.

export const dashboardProject = pgView("DashboardProject", {
  id: text().notNull(),
  title: text().notNull(),
  tags: text().array(),
  domain: text().notNull(),
  userId: text(),
  workspaceId: uuid(),
  isDeleted: boolean().notNull(),
  createdAt: timestamptz("createdAt").notNull(),
  previewImageAssetId: text(),
  marketplaceApprovalStatus: marketplaceApprovalStatus().notNull(),
  isPublished: boolean().notNull(),
  publishedUrl: text(),
}).as(
  sql`SELECT "Project".id, "Project".title, "Project".tags, "Project".domain, "Project"."userId", "Project"."workspaceId", "Project"."isDeleted", "Project"."createdAt", "Project"."previewImageAssetId", "Project"."marketplaceApprovalStatus", (EXISTS ( SELECT 1 FROM "Build" WHERE "Build"."projectId" = "Project".id AND "Build".deployment IS NOT NULL)) AS "isPublished", "Project"."publishedUrl" FROM "Project"`
);

export const approvedMarketplaceProduct = pgView("ApprovedMarketplaceProduct", {
  projectId: text().notNull(),
  marketplaceProduct: text().notNull(),
  authorizationToken: text(),
}).as(
  sql`SELECT DISTINCT ON (build."projectId") build."projectId", build."marketplaceProduct", ( SELECT auth.token FROM "AuthorizationToken" auth WHERE auth."projectId" = build."projectId" AND auth.relation = 'viewers'::"AuthorizationRelation" ORDER BY auth.token LIMIT 1) AS "authorizationToken" FROM "Build" build WHERE build.deployment IS NOT NULL AND (build."projectId" IN ( SELECT "Project".id FROM "Project" WHERE "Project"."isDeleted" = false AND "Project"."marketplaceApprovalStatus" = 'APPROVED'::text::"MarketplaceApprovalStatus")) ORDER BY build."projectId", build."createdAt" DESC, build.id`
);

export const latestStaticBuildPerProject = pgView(
  "LatestStaticBuildPerProject",
  {
    buildId: text().notNull(),
    projectId: text().notNull(),
    updatedAt: timestamptz("updatedAt").notNull(),
    publishStatus: publishStatus().notNull(),
  }
).as(
  sql`SELECT DISTINCT ON (bld."projectId") bld.id AS "buildId", bld."projectId", bld."updatedAt", bld."publishStatus" FROM "Build" bld WHERE bld.deployment IS NOT NULL AND (bld.deployment::jsonb ->> 'destination'::text) = 'static'::text ORDER BY bld."projectId", bld."createdAt" DESC, bld.id`
);

export const workspaceProjectAuthorization = pgView(
  "WorkspaceProjectAuthorization",
  {
    userId: text().notNull(),
    projectId: text().notNull(),
    relation: text().notNull(),
  }
).as(
  sql`SELECT w."userId", p.id AS "projectId", 'own'::text AS relation FROM "Workspace" w JOIN "Project" p ON p."workspaceId" = w.id WHERE w."isDeleted" = false AND p."isDeleted" = false UNION ALL SELECT wm."userId", p.id AS "projectId", wm.relation::text AS relation FROM "WorkspaceMember" wm JOIN "Workspace" w ON w.id = wm."workspaceId" JOIN "Project" p ON p."workspaceId" = wm."workspaceId" WHERE wm."removedAt" IS NULL AND w."isDeleted" = false AND p."isDeleted" = false`
);

export const userProduct = pgView("UserProduct", {
  userId: text(),
  subscriptionId: text(),
  productId: text(),
  customerId: text(),
  customerEmail: text(),
}).as(
  sql`( SELECT tl."userId", tl."subscriptionId", tl."productId", tl."customerId", tl."customerEmail" FROM "TransactionLog" tl WHERE tl.status = 'complete'::text AND tl."eventType" = 'checkout.session.completed'::text AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" failed WHERE failed."eventType" = 'checkout.session.async_payment_failed'::text AND (failed."eventData" #>> '{data,object,id}'::text[]) = (tl."eventData" #>> '{data,object,id}'::text[]) AND failed."eventCreated" >= tl."eventCreated")) AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" tlexsists WHERE tlexsists."subscriptionId" = tl."subscriptionId" AND tlexsists."eventType" = 'customer.subscription.deleted'::text AND tlexsists.status = 'canceled'::text AND tlexsists."eventCreated" > tl."eventCreated")) AND NOT (EXISTS ( SELECT 1 FROM "TransactionLog" tlexsists WHERE tlexsists."paymentIntent" = tl."paymentIntent" AND tlexsists."eventType" = 'charge.refunded'::text AND tlexsists.status = 'succeeded'::text AND tlexsists."eventCreated" > tl."eventCreated")) ORDER BY tl."userId", tl."eventCreated" DESC) UNION ALL SELECT "TransactionLog"."userId", "TransactionLog"."subscriptionId", "TransactionLog"."productId", "TransactionLog"."customerId", "TransactionLog"."customerEmail" FROM "TransactionLog" WHERE "TransactionLog"."eventType" = 'appsumo.activate'::text`
);

export const publishedBuilds = pgView("published_builds", {
  buildId: text().notNull(),
  projectId: text().notNull(),
  createdAt: timestamptz("createdAt").notNull(),
  domains: text(),
}).as(
  sql`SELECT build.id AS "buildId", build."projectId", build."createdAt", ( SELECT string_agg(list.value, ', '::text) AS string_agg FROM jsonb_array_elements_text(build.deployment::jsonb -> 'domains'::text) list(value)) AS domains FROM "Build" build WHERE build.deployment IS NOT NULL AND build."isCleaned" = false ORDER BY build."projectId", build."createdAt" DESC`
);

export const userPublishCount = pgView("user_publish_count", {
  user_id: text(),
  count: bigint({ mode: "number" }).notNull(),
}).as(
  sql`SELECT DISTINCT "Project"."userId" AS user_id, count(*) AS count FROM "Build" LEFT JOIN "Project" ON "Project".id = "Build"."projectId" WHERE date_trunc('day'::text, "Build"."createdAt") = date_trunc('day'::text, now()) AND "Build".deployment IS NOT NULL GROUP BY "Project"."userId"`
);
