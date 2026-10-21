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
