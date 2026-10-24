import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { Db } from "./db";
import { asset } from "./schema/tables";
import type { DomainsVirtual, LatestBuildVirtual } from "./types";

// Replacements for upstream's PostgREST computed relationships (the SQL functions
// "latestBuildVirtual" and "domainsVirtual"). Same filters, ordering and shapes,
// batched per list of projects.

const toIso = (value: unknown) => new Date(value as string).toISOString();

type LatestBuildRow = {
  buildId: string;
  projectId: string;
  domain: string;
  createdAt: unknown;
  publishStatus: LatestBuildVirtual["publishStatus"];
  publishError: string | null;
  updatedAt: unknown;
};

const toLatestBuild = (row: LatestBuildRow): LatestBuildVirtual => ({
  buildId: row.buildId,
  projectId: row.projectId,
  domainsVirtualId: "",
  domain: row.domain,
  createdAt: toIso(row.createdAt),
  publishStatus: row.publishStatus,
  publishError: row.publishError ?? null,
  updatedAt: toIso(row.updatedAt),
});

/**
 * The latest production (non-static) build of each project whose deployment includes
 * the project's own domain or one of its custom domains.
 */
export const loadLatestBuildVirtual = async (
  db: Db,
  projectIds: readonly string[]
): Promise<Map<string, LatestBuildVirtual>> => {
  const result = new Map<string, LatestBuildVirtual>();
  if (projectIds.length === 0) {
    return result;
  }
  const { rows } = await db.execute<LatestBuildRow>(sql`
    SELECT DISTINCT ON (b."projectId")
      b.id AS "buildId",
      b."projectId",
      CASE
        WHEN (b.deployment::jsonb ->> 'projectDomain') = p.domain
          OR (b.deployment::jsonb -> 'domains') @> to_jsonb(array[p.domain]) THEN p.domain
        ELSE d.domain
      END AS domain,
      b."createdAt",
      b."publishStatus",
      b."publishError",
      b."updatedAt"
    FROM "Build" b
    JOIN "Project" p ON b."projectId" = p.id
    LEFT JOIN "ProjectDomain" pd ON pd."projectId" = p.id
    LEFT JOIN "Domain" d ON d.id = pd."domainId"
    WHERE b."projectId" IN ${projectIds}
      AND b.deployment IS NOT NULL
      AND (
        (b.deployment::jsonb ->> 'destination') IS NULL
        OR (b.deployment::jsonb ->> 'destination') = 'saas'
      )
      AND (
        (b.deployment::jsonb ->> 'projectDomain') = p.domain
        OR (b.deployment::jsonb -> 'domains') @> to_jsonb(array[p.domain])
        OR (b.deployment::jsonb -> 'domains') @> to_jsonb(array[d.domain])
      )
    ORDER BY b."projectId", b."createdAt" DESC
  `);
  for (const row of rows) {
    result.set(row.projectId, toLatestBuild(row));
  }
  return result;
};

export type DomainsVirtualWithLatestBuild = DomainsVirtual & {
  latestBuildVirtual: LatestBuildVirtual | null;
};

type DomainRow = Omit<DomainsVirtual, "createdAt" | "updatedAt"> & {
  createdAt: unknown;
  updatedAt: unknown;
};

/**
 * The custom domains of each project, each with the latest build whose deployment
 * includes that domain.
 */
export const loadDomainsVirtual = async (
  db: Db,
  projectIds: readonly string[]
): Promise<Map<string, DomainsVirtualWithLatestBuild[]>> => {
  const result = new Map<string, DomainsVirtualWithLatestBuild[]>();
  if (projectIds.length === 0) {
    return result;
  }
  const domains = await db.execute<DomainRow>(sql`
    SELECT
      d.id || '-' || pd."projectId" AS id,
      d.id AS "domainId",
      pd."projectId",
      d.domain,
      d.status,
      d.error,
      d."txtRecord" AS "domainTxtRecord",
      pd."txtRecord" AS "expectedTxtRecord",
      pd.cname,
      (d."txtRecord" IS NOT DISTINCT FROM pd."txtRecord" AND d."txtRecord" IS NOT NULL) AS verified,
      pd."createdAt",
      d."updatedAt"
    FROM "Domain" d
    JOIN "ProjectDomain" pd ON d.id = pd."domainId"
    WHERE pd."projectId" IN ${projectIds}
    ORDER BY pd."createdAt", d.id
  `);
  if (domains.rows.length === 0) {
    return result;
  }

  const builds = await db.execute<LatestBuildRow & { domainId: string }>(sql`
    SELECT DISTINCT ON (pd."projectId", pd."domainId")
      b.id AS "buildId",
      b."projectId",
      pd."domainId",
      d.domain,
      b."createdAt",
      b."publishStatus",
      b."publishError",
      b."updatedAt"
    FROM "ProjectDomain" pd
    JOIN "Domain" d ON d.id = pd."domainId"
    JOIN "Build" b ON b."projectId" = pd."projectId"
    WHERE pd."projectId" IN ${projectIds}
      AND b.deployment IS NOT NULL
      AND (b.deployment::jsonb -> 'domains') @> to_jsonb(array[d.domain])
    ORDER BY pd."projectId", pd."domainId", b."createdAt" DESC
  `);
  const buildByDomain = new Map<string, LatestBuildVirtual>();
  for (const row of builds.rows) {
    buildByDomain.set(`${row.projectId}\0${row.domainId}`, toLatestBuild(row));
  }

  for (const row of domains.rows) {
    const list = result.get(row.projectId) ?? [];
    list.push({
      ...row,
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
      latestBuildVirtual:
        buildByDomain.get(`${row.projectId}\0${row.domainId}`) ?? null,
    });
    result.set(row.projectId, list);
  }
  return result;
};

/**
 * Each project's preview image asset, as upstream's `previewImageAsset:Asset (*)`
 * PostgREST embed returned it.
 */
export const loadPreviewImageAssets = async (
  db: Db,
  projects: ReadonlyArray<{ id: string; previewImageAssetId: string | null }>
): Promise<Map<string, typeof asset.$inferSelect>> => {
  const result = new Map<string, typeof asset.$inferSelect>();
  const withPreview = projects.flatMap((project) =>
    project.previewImageAssetId === null
      ? []
      : [{ id: project.id, assetId: project.previewImageAssetId }]
  );
  if (withPreview.length === 0) {
    return result;
  }
  const rows = await db
    .select()
    .from(asset)
    .where(
      and(
        inArray(
          asset.projectId,
          withPreview.map((project) => project.id)
        ),
        or(
          ...withPreview.map((project) =>
            and(eq(asset.projectId, project.id), eq(asset.id, project.assetId))
          )
        )
      )
    );
  for (const row of rows) {
    result.set(row.projectId, row);
  }
  return result;
};
