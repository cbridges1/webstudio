// The few reads and writes the deployer needs, through the fork's Drizzle schema
// (@webstudio-is/db, linked from the Webstudio checkout). Kept in one module because
// writing `Build.publishStatus` and `Project.publishedUrl` couples us to the builder's schema.
import { and, build, eq, project, type Db } from "@webstudio-is/db";

export type PublishStatus = "PENDING" | "PUBLISHED" | "FAILED";

export type BuildRow = {
  id: string;
  projectId: string;
  deployment: string | null;
  publishStatus: PublishStatus;
};

export type Database = {
  getBuild(buildId: string): Promise<BuildRow | undefined>;
  setPublishStatus(buildId: string, status: PublishStatus): Promise<void>;
  findProjectIdByDomain(domain: string): Promise<string | undefined>;
  /** The link the dashboard and builder show for the project's site. */
  setPublishedUrl(projectId: string, url: string): Promise<void>;
  clearPublishedUrl(projectId: string): Promise<void>;
};

export const createDatabase = (db: Db): Database => ({
  async getBuild(buildId) {
    const [row] = await db
      .select({
        id: build.id,
        projectId: build.projectId,
        deployment: build.deployment,
        publishStatus: build.publishStatus,
      })
      .from(build)
      .where(eq(build.id, buildId));
    return row;
  },
  async setPublishStatus(buildId, status) {
    await db
      .update(build)
      .set({ publishStatus: status, updatedAt: new Date().toISOString() })
      .where(eq(build.id, buildId));
  },
  async findProjectIdByDomain(domain) {
    const [row] = await db
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.domain, domain), eq(project.isDeleted, false)));
    return row?.id;
  },
  async setPublishedUrl(projectId, url) {
    await db
      .update(project)
      .set({ publishedUrl: url })
      .where(eq(project.id, projectId));
  },
  async clearPublishedUrl(projectId) {
    await db
      .update(project)
      .set({ publishedUrl: null })
      .where(eq(project.id, projectId));
  },
});
