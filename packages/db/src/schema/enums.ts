import { pgEnum } from "drizzle-orm/pg-core";

export const authorizationRelation = pgEnum("AuthorizationRelation", [
  "viewers",
  "editors",
  "builders",
  "administrators",
]);

export const domainStatus = pgEnum("DomainStatus", [
  "INITIALIZING",
  "ACTIVE",
  "ERROR",
  "PENDING",
]);

export const marketplaceApprovalStatus = pgEnum("MarketplaceApprovalStatus", [
  "UNLISTED",
  "PENDING",
  "APPROVED",
  "REJECTED",
]);

export const publishStatus = pgEnum("PublishStatus", [
  "PENDING",
  "PUBLISHED",
  "FAILED",
]);

export const uploadStatus = pgEnum("UploadStatus", ["UPLOADING", "UPLOADED"]);

// selfhost: the deploy service's job queue (DeployJob).
export const deployJobKind = pgEnum("DeployJobKind", [
  "publish",
  "unpublish",
  "validate",
]);

export const deployJobStatus = pgEnum("DeployJobStatus", [
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
