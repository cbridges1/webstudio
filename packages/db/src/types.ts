import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import type { PgTable, PgView } from "drizzle-orm/pg-core";
import * as tables from "./schema/tables";
import * as views from "./schema/views";
import type {
  authorizationRelation,
  domainStatus,
  marketplaceApprovalStatus,
  publishStatus,
  uploadStatus,
} from "./schema/enums";

type TableTypes<Table extends PgTable> = {
  Row: InferSelectModel<Table>;
  Insert: InferInsertModel<Table>;
  Update: Partial<InferInsertModel<Table>>;
};

type ViewRow<View extends PgView> = View["$inferSelect"];

/**
 * Domain data for a project, as upstream's `domainsVirtual` PostgREST relationship
 * returned it.
 */
export type DomainsVirtual = {
  id: string;
  domainId: string;
  projectId: string;
  domain: string;
  status: Database["public"]["Enums"]["DomainStatus"];
  error: string | null;
  domainTxtRecord: string | null;
  expectedTxtRecord: string;
  cname: string;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
};

/**
 * The latest production build for a project or domain, as upstream's
 * `latestBuildVirtual` PostgREST relationship returned it.
 */
export type LatestBuildVirtual = {
  buildId: string;
  projectId: string;
  domainsVirtualId: string;
  domain: string;
  createdAt: string;
  publishStatus: Database["public"]["Enums"]["PublishStatus"];
  updatedAt: string;
};

/**
 * Row types keyed by table name, in the shape upstream's generated PostgREST types
 * used (`Database["public"]["Tables"]["Build"]["Row"]`), so type references only need
 * a new import path.
 */
export type Database = {
  public: {
    Tables: {
      Asset: TableTypes<typeof tables.asset>;
      AssetFileMetadata: TableTypes<typeof tables.assetFileMetadata>;
      AssetFolder: TableTypes<typeof tables.assetFolder>;
      AuthorizationToken: TableTypes<typeof tables.authorizationToken>;
      Build: TableTypes<typeof tables.build>;
      ClientReferences: TableTypes<typeof tables.clientReferences>;
      Domain: TableTypes<typeof tables.domain>;
      File: TableTypes<typeof tables.file>;
      Notification: TableTypes<typeof tables.notification>;
      Product: TableTypes<typeof tables.product>;
      Project: TableTypes<typeof tables.project>;
      ProjectDomain: TableTypes<typeof tables.projectDomain>;
      TransactionLog: TableTypes<typeof tables.transactionLog>;
      User: TableTypes<typeof tables.user>;
      Workspace: TableTypes<typeof tables.workspace>;
      WorkspaceMember: TableTypes<typeof tables.workspaceMember>;
      domainsVirtual: { Row: DomainsVirtual };
      latestBuildVirtual: { Row: LatestBuildVirtual };
    };
    Views: {
      ApprovedMarketplaceProduct: {
        Row: ViewRow<typeof views.approvedMarketplaceProduct>;
      };
      DashboardProject: { Row: ViewRow<typeof views.dashboardProject> };
      LatestStaticBuildPerProject: {
        Row: ViewRow<typeof views.latestStaticBuildPerProject>;
      };
      UserProduct: { Row: ViewRow<typeof views.userProduct> };
      WorkspaceProjectAuthorization: {
        Row: ViewRow<typeof views.workspaceProjectAuthorization>;
      };
      published_builds: { Row: ViewRow<typeof views.publishedBuilds> };
      user_publish_count: { Row: ViewRow<typeof views.userPublishCount> };
    };
    Enums: {
      AuthorizationRelation: (typeof authorizationRelation.enumValues)[number];
      DomainStatus: (typeof domainStatus.enumValues)[number];
      MarketplaceApprovalStatus: (typeof marketplaceApprovalStatus.enumValues)[number];
      PublishStatus: (typeof publishStatus.enumValues)[number];
      UploadStatus: (typeof uploadStatus.enumValues)[number];
    };
  };
};

export type Tables<Name extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][Name]["Row"];
