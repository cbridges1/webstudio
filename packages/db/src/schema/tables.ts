import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";
import { timestamptz } from "./columns";
import type { Json } from "./json";
import {
  authorizationRelation,
  deployJobKind,
  deployJobStatus,
  domainStatus,
  marketplaceApprovalStatus,
  publishStatus,
  uploadStatus,
} from "./enums";

// Table and column names match upstream's database exactly (quoted PascalCase tables,
// camelCase columns), so rows keep the shape upstream code expects and upstream schema
// changes translate 1:1.

const createdAt = () =>
  timestamptz("createdAt")
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull();

export const user = pgTable(
  "User",
  {
    id: text().primaryKey(),
    createdAt: createdAt(),
    email: text(),
    image: text(),
    provider: text(),
    /** Display name. Better Auth's `name`. */
    username: text(),
    projectsTags: jsonb().$type<Json>().default([]).notNull(),
    // selfhost: Better Auth (username/password sign-in). Columns it owns on the
    // shared user row; the password itself lives in AuthAccount.
    /** Sign-in username, lowercased. Better Auth's `username`. */
    loginName: text(),
    displayUsername: text(),
    emailVerified: boolean().default(false).notNull(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`now()`)
      .notNull(),
    role: text(),
    banned: boolean().default(false),
    banReason: text(),
    banExpires: timestamp({ precision: 3, withTimezone: true }),
  },
  (table) => [
    uniqueIndex("User_email_key").on(table.email),
    uniqueIndex("User_loginName_key").on(table.loginName),
  ]
);

export const workspace = pgTable(
  "Workspace",
  {
    id: uuid().defaultRandom().primaryKey(),
    name: text().notNull(),
    isDefault: boolean().default(false).notNull(),
    createdAt: timestamptz("createdAt")
      .default(sql`now()`)
      .notNull(),
    userId: text().notNull(),
    isDeleted: boolean().default(false).notNull(),
  },
  (table) => [
    uniqueIndex("Workspace_userId_isDefault_key")
      .on(table.userId, table.isDefault)
      .where(sql`("isDefault" = true)`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "Workspace_userId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ]
);

export const workspaceMember = pgTable(
  "WorkspaceMember",
  {
    workspaceId: uuid().notNull(),
    userId: text().notNull(),
    relation: authorizationRelation().default("administrators").notNull(),
    createdAt: timestamptz("createdAt")
      .default(sql`now()`)
      .notNull(),
    removedAt: timestamptz("removedAt"),
  },
  (table) => [
    primaryKey({
      columns: [table.workspaceId, table.userId],
      name: "WorkspaceMember_pkey",
    }),
    index("WorkspaceMember_userId_idx").on(table.userId),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: "WorkspaceMember_workspaceId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "WorkspaceMember_userId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
  ]
);

export const project = pgTable(
  "Project",
  {
    id: text().primaryKey(),
    title: text().notNull(),
    domain: text().notNull(),
    userId: text(),
    isDeleted: boolean().default(false).notNull(),
    createdAt: createdAt(),
    previewImageAssetId: text(),
    marketplaceApprovalStatus: marketplaceApprovalStatus()
      .default("UNLISTED")
      .notNull(),
    tags: text().array(),
    workspaceId: uuid(),
    // selfhost: address of the published site, reported by the deploy service.
    // Each project deploys to its own host, so `<domain>.<PUBLISHER_HOST>` is only
    // the fallback before the first deploy.
    publishedUrl: text(),
  },
  (table): PgTableExtraConfigValue[] => [
    uniqueIndex("Project_domain_isDeleted_key").on(
      table.domain,
      table.isDeleted
    ),
    uniqueIndex("Project_domain_key").on(table.domain),
    uniqueIndex("Project_id_domain_key").on(table.id, table.domain),
    uniqueIndex("Project_id_isDeleted_key").on(table.id, table.isDeleted),
    index("Project_isDeleted_marketplaceApprovalStatus_idx").on(
      table.isDeleted,
      table.marketplaceApprovalStatus
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "Project_userId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
    foreignKey({
      columns: [table.previewImageAssetId, table.id],
      foreignColumns: [asset.id, asset.projectId],
      name: "Project_previewImageAssetId_id_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
    foreignKey({
      columns: [table.workspaceId],
      foreignColumns: [workspace.id],
      name: "Project_workspaceId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
  ]
);

// selfhost: the builder hands work to the deploy service (apps/deploy) through the database.
// It queues a DeployJob and sends NOTIFY "deploy_jobs"; the deploy service LISTENs (and polls,
// for missed notifications), claims jobs with FOR UPDATE SKIP LOCKED and records the outcome.
// It registers itself and its hosts in DeployWorker. Its own database login can read
// ProjectDeployTarget and DeployJob, update DeployJob's progress columns and write
// DeployWorker; nothing else.

/**
 * How the builder reaches the deploy service, set by an app admin unless the builder's
 * environment sets it (DEPLOYER_WAKE_URL, DEPLOYER_BUILDER_URL). At most one row.
 */
export const deploySettings = pgTable(
  "DeploySettings",
  {
    id: uuid().defaultRandom().primaryKey(),
    /** Called (POST) whenever a job is queued, e.g. to start a stopped deploy service. */
    wakeUrl: text(),
    /** Sent as `Authorization: Bearer <wakeToken>` to wakeUrl. */
    wakeToken: text(),
    /** The builder's address as the deploy service reaches it. Null: the builder's own origin. */
    builderUrl: text(),
    /**
     * "builtin": the builder runs the deploy service's worker itself; "separate": a deploy
     * service (apps/deploy) runs on its own. Null: the builder's DEPLOYER_MODE.
     */
    mode: text(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`now()`)
      .notNull(),
  },
  () => [uniqueIndex("DeploySettings_single_key").on(sql`(true)`)]
);

export const deployJob = pgTable(
  "DeployJob",
  {
    id: uuid().defaultRandom().primaryKey(),
    /**
     * Which deploy services may take it (DEPLOYER_QUEUE / DEPLOY_QUEUE), for builders sharing
     * a database whose deploy services can each reach only their own builder.
     */
    queue: text().default("default").notNull(),
    kind: deployJobKind().notNull(),
    projectId: text().notNull(),
    /** publish only. */
    buildId: text(),
    /**
     * publish: { builderOrigin, token, label }. The token reads the project for two hours, so
     * this is a secret.
     */
    request: jsonb().$type<Json>().notNull(),
    status: deployJobStatus().default("queued").notNull(),
    error: text(),
    /** publish: { url }. */
    result: jsonb().$type<Json>(),
    attempts: integer().default(0).notNull(),
    workerId: text(),
    createdAt: createdAt(),
    startedAt: timestamptz("startedAt"),
    /** Updated while a job runs; a stale one belonged to a worker that died. */
    heartbeatAt: timestamptz("heartbeatAt"),
    finishedAt: timestamptz("finishedAt"),
  },
  (table) => [
    index("DeployJob_queue_status_createdAt_idx").on(
      table.queue,
      table.status,
      table.createdAt
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "DeployJob_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
  ]
);

/** Running deploy services: their hosts (for the builder's settings form) and when last seen. */
export const deployWorker = pgTable("DeployWorker", {
  id: text().primaryKey(),
  /** The queue it takes jobs from. */
  queue: text().default("default").notNull(),
  /** HostInfo[] (@webstudio-is/deploy-protocol). */
  hosts: jsonb().$type<Json>().notNull(),
  startedAt: timestamptz("startedAt")
    .default(sql`now()`)
    .notNull(),
  seenAt: timestamptz("seenAt")
    .default(sql`now()`)
    .notNull(),
});

// selfhost: how the builder sends email (workspace invites, password resets), set by an app
// admin unless the builder's environment sets SMTP_HOST. At most one row. `password` is
// encrypted with a key derived from AUTH_SECRET.
export const emailSettings = pgTable(
  "EmailSettings",
  {
    id: uuid().defaultRandom().primaryKey(),
    host: text().notNull(),
    port: integer().notNull(),
    /** TLS from the start (port 465); otherwise STARTTLS when the server offers it. */
    secure: boolean().default(false).notNull(),
    username: text(),
    password: text(),
    /** The From address, e.g. `Webstudio <noreply@example.com>`. */
    from: text().notNull(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`now()`)
      .notNull(),
  },
  () => [uniqueIndex("EmailSettings_single_key").on(sql`(true)`)]
);

// selfhost: where Publish sends a project on the deployer: a host, its settings and the
// host's credentials, encrypted with DEPLOY_CREDENTIALS_KEY (the deployer reads only that
// column).
export const projectDeployTarget = pgTable(
  "ProjectDeployTarget",
  {
    projectId: text().primaryKey(),
    host: text().notNull(),
    config: jsonb().$type<Json>().notNull(),
    credentials: text(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`now()`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "ProjectDeployTarget_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
  ]
);

export const build = pgTable(
  "Build",
  {
    id: text().notNull(),
    createdAt: createdAt(),
    pages: text().notNull(),
    projectId: text().notNull(),
    styleSources: text().default("[]").notNull(),
    styles: text().default("[]").notNull(),
    breakpoints: text().default("[]").notNull(),
    styleSourceSelections: text().default("[]").notNull(),
    props: text().default("[]").notNull(),
    instances: text().default("[]").notNull(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    version: integer().default(0).notNull(),
    deployment: text(),
    publishStatus: publishStatus().default("PENDING").notNull(),
    // selfhost: why the deployer failed or refused this publish (shown in Publish).
    publishError: text(),
    dataSources: text().default("[]").notNull(),
    lastTransactionId: text(),
    resources: text().default("[]").notNull(),
    marketplaceProduct: text().default("{}").notNull(),
    isCleaned: boolean().default(false),
    projectSettings: text().default('{"meta":{},"compiler":{}}').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id, table.projectId], name: "Build_pkey" }),
    uniqueIndex("Build_id_key").on(table.id),
    uniqueIndex("Build_dev_index")
      .on(table.projectId)
      .where(sql`(deployment IS NULL)`),
    index("Build_projectId_createdAt_idx").on(
      table.projectId,
      table.createdAt.desc().nullsFirst()
    ),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "Build_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ]
);

export const file = pgTable(
  "File",
  {
    name: text().primaryKey(),
    format: text().notNull(),
    size: integer().notNull(),
    description: text(),
    createdAt: createdAt(),
    meta: text().default("{}").notNull(),
    status: uploadStatus().default("UPLOADING").notNull(),
    uploaderProjectId: text(),
    isDeleted: boolean().default(false).notNull(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    contentHash: varchar({ length: 64 }),
  },
  (table): PgTableExtraConfigValue[] => [
    // One stored file per project, content hash and lowercased extension.
    uniqueIndex("File_uploaderProjectId_contentHash_extension_key")
      .on(
        table.uploaderProjectId,
        table.contentHash,
        sql`(CASE WHEN ((strpos(reverse(name), '.'::text) = ANY (ARRAY[0, 1])) OR (((length(name) - strpos(reverse(name), '.'::text)) + 1) = 1)) THEN ''::text ELSE lower(reverse(split_part(reverse(name), '.'::text, 1))) END)`
      )
      .where(sql`("contentHash" IS NOT NULL)`),
    foreignKey({
      columns: [table.uploaderProjectId],
      foreignColumns: [project.id],
      name: "File_uploaderProjectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
  ]
);

export const assetFolder = pgTable(
  "AssetFolder",
  {
    id: text()
      .default(sql`gen_random_uuid()`)
      .notNull(),
    projectId: text().notNull(),
    name: text().notNull(),
    parentId: text(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({
      columns: [table.id, table.projectId],
      name: "AssetFolder_pkey",
    }),
    index("AssetFolder_projectId_parentId_idx").on(
      table.projectId,
      table.parentId
    ),
    uniqueIndex("AssetFolder_unique_sibling_name").on(
      table.projectId,
      sql`COALESCE("parentId", ''::text)`,
      sql`lower(btrim(name))`
    ),
    check("AssetFolder_name_not_blank", sql`(btrim(name) <> ''::text)`),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "AssetFolder_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
    foreignKey({
      columns: [table.parentId, table.projectId],
      foreignColumns: [table.id, table.projectId],
      name: "AssetFolder_parentId_projectId_fkey",
    }).onUpdate("cascade"),
  ]
);

export const asset = pgTable(
  "Asset",
  {
    id: text().notNull(),
    projectId: text().notNull(),
    name: text().notNull(),
    description: text(),
    filename: text(),
    folderId: text(),
  },
  (table): PgTableExtraConfigValue[] => [
    primaryKey({ columns: [table.id, table.projectId], name: "Asset_pkey" }),
    foreignKey({
      columns: [table.name],
      foreignColumns: [file.name],
      name: "Asset_name_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
    foreignKey({
      columns: [table.folderId, table.projectId],
      foreignColumns: [assetFolder.id, assetFolder.projectId],
      name: "Asset_folderId_projectId_fkey",
    }).onUpdate("cascade"),
  ]
);

export const assetFileMetadata = pgTable(
  "AssetFileMetadata",
  {
    projectId: text().notNull(),
    assetId: text().notNull(),
    revision: text().notNull(),
    document: jsonb().$type<Json>().notNull(),
    createdAt: createdAt(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.assetId],
      name: "AssetFileMetadata_pkey",
    }),
    check(
      "AssetFileMetadata_document_identity_check",
      sql`((((jsonb_typeof(document) = 'object'::text) AND (jsonb_typeof((document -> '_id'::text)) = 'string'::text) AND ((document ->> '_id'::text) = "assetId") AND (jsonb_typeof((document -> 'revision'::text)) = 'string'::text) AND ((document ->> 'revision'::text) = revision)) IS TRUE))`
    ),
    foreignKey({
      columns: [table.assetId, table.projectId],
      foreignColumns: [asset.id, asset.projectId],
      name: "AssetFileMetadata_assetId_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("cascade"),
  ]
);

export const authorizationToken = pgTable(
  "AuthorizationToken",
  {
    token: text().notNull(),
    projectId: text().notNull(),
    name: text().default("").notNull(),
    relation: authorizationRelation().default("viewers").notNull(),
    createdAt: createdAt(),
    canClone: boolean().default(true).notNull(),
    canCopy: boolean().default(true).notNull(),
    canPublish: boolean().default(false).notNull(),
    canUseApi: boolean().default(false).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.token, table.projectId],
      name: "AuthorizationToken_pkey",
    }),
    uniqueIndex("AuthorizationToken_token_key").on(table.token),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "AuthorizationToken_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ]
);

export const domain = pgTable(
  "Domain",
  {
    id: text().primaryKey(),
    domain: text().notNull(),
    createdAt: createdAt(),
    txtRecord: text(),
    status: domainStatus().default("INITIALIZING").notNull(),
    error: text(),
    updatedAt: timestamptz("updatedAt")
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [uniqueIndex("Domain_domain_key").on(table.domain)]
);

export const projectDomain = pgTable(
  "ProjectDomain",
  {
    projectId: text().notNull(),
    domainId: text().notNull(),
    createdAt: createdAt(),
    txtRecord: text().notNull(),
    cname: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.domainId],
      name: "ProjectDomain_pkey",
    }),
    index("ProjectDomain_domainId_idx").on(table.domainId),
    uniqueIndex("ProjectDomain_txtRecord_key").on(table.txtRecord),
    foreignKey({
      columns: [table.projectId],
      foreignColumns: [project.id],
      name: "ProjectDomain_projectId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
    foreignKey({
      columns: [table.domainId],
      foreignColumns: [domain.id],
      name: "ProjectDomain_domainId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ]
);

export const notification = pgTable(
  "Notification",
  {
    id: uuid().defaultRandom().primaryKey(),
    type: text().notNull(),
    recipientId: text().notNull(),
    senderId: text().notNull(),
    status: text().default("pending").notNull(),
    payload: jsonb().$type<Json>().default({}).notNull(),
    createdAt: timestamptz("createdAt")
      .default(sql`now()`)
      .notNull(),
    respondedAt: timestamptz("respondedAt"),
  },
  (table) => [
    index("Notification_recipientId_status_idx").on(
      table.recipientId,
      table.status
    ),
  ]
);

export const product = pgTable("Product", {
  id: text().primaryKey(),
  name: text().notNull(),
  description: text(),
  features: text().array(),
  images: text().array(),
  meta: jsonb().$type<Json>().notNull(),
  createdAt: createdAt(),
});

export const transactionLog = pgTable(
  "TransactionLog",
  {
    eventId: text().primaryKey(),
    productId: text(),
    userId: text(),
    createdAt: createdAt(),
    eventData: jsonb().$type<Json>(),
    eventCreated: integer().generatedAlwaysAs(
      sql`(("eventData" #>> '{created}'::text[]))::integer`
    ),
    eventType: text().generatedAlwaysAs(
      sql`("eventData" #>> '{type}'::text[])`
    ),
    status: text().generatedAlwaysAs(
      sql`("eventData" #>> '{data,object,status}'::text[])`
    ),
    customerId: text().generatedAlwaysAs(
      sql`("eventData" #>> '{data,object,customer}'::text[])`
    ),
    customerEmail: text().generatedAlwaysAs(
      sql`("eventData" #>> '{data,object,customer_details,email}'::text[])`
    ),
    subscriptionId: text().generatedAlwaysAs(
      sql`CASE WHEN (("eventData" #>> '{data,object,object}'::text[]) = 'subscription'::text) THEN ("eventData" #>> '{data,object,id}'::text[]) ELSE ("eventData" #>> '{data,object,subscription}'::text[]) END`
    ),
    paymentIntent: text().generatedAlwaysAs(
      sql`("eventData" #>> '{data,object,payment_intent}'::text[])`
    ),
  },
  (table) => [
    uniqueIndex("TransactionLog_eventId_productId_key").on(
      table.eventId,
      table.productId
    ),
    foreignKey({
      columns: [table.productId],
      foreignColumns: [product.id],
      name: "TransactionLog_productId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "TransactionLog_userId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("set null"),
  ]
);

export const clientReferences = pgTable(
  "ClientReferences",
  {
    reference: text()
      .default(sql`gen_random_uuid()`)
      .notNull(),
    service: text().notNull(),
    createdAt: createdAt(),
    userId: text().notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.service],
      name: "ClientReferences_pkey",
    }),
    uniqueIndex("ClientReferences_reference_service_key").on(
      table.reference,
      table.service
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "ClientReferences_userId_fkey",
    })
      .onUpdate("cascade")
      .onDelete("restrict"),
  ]
);

// selfhost: Better Auth tables. Named after Better Auth's models with an "Auth"
// prefix to sit next to upstream's tables; its dates use Date objects.

const authDate = (name: string) =>
  timestamp(name, { precision: 3, withTimezone: true });

export const authSession = pgTable(
  "AuthSession",
  {
    id: text().primaryKey(),
    expiresAt: authDate("expiresAt").notNull(),
    token: text().notNull(),
    createdAt: authDate("createdAt").defaultNow().notNull(),
    updatedAt: authDate("updatedAt").defaultNow().notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text(),
  },
  (table) => [
    uniqueIndex("AuthSession_token_key").on(table.token),
    index("AuthSession_userId_idx").on(table.userId),
  ]
);

export const authAccount = pgTable(
  "AuthAccount",
  {
    id: text().primaryKey(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text()
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: authDate("accessTokenExpiresAt"),
    refreshTokenExpiresAt: authDate("refreshTokenExpiresAt"),
    scope: text(),
    password: text(),
    createdAt: authDate("createdAt").defaultNow().notNull(),
    updatedAt: authDate("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("AuthAccount_userId_idx").on(table.userId)]
);

export const authVerification = pgTable(
  "AuthVerification",
  {
    id: text().primaryKey(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: authDate("expiresAt").notNull(),
    createdAt: authDate("createdAt").defaultNow().notNull(),
    updatedAt: authDate("updatedAt").defaultNow().notNull(),
  },
  (table) => [index("AuthVerification_identifier_idx").on(table.identifier)]
);

export const authRateLimit = pgTable(
  "AuthRateLimit",
  {
    id: text().primaryKey(),
    key: text().notNull(),
    count: integer().notNull(),
    lastRequest: bigint({ mode: "number" }).notNull(),
  },
  (table) => [uniqueIndex("AuthRateLimit_key_key").on(table.key)]
);
