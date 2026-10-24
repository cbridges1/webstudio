import { z } from "zod";
import * as projectApi from "@webstudio-is/project/index.server";
import {
  createProductionBuild,
  unpublishBuild,
} from "@webstudio-is/project-build/server";
import { parseDeployment } from "@webstudio-is/project-build/persistence";
import {
  createId,
  getPublishTarget,
  publishedDeploymentDestination,
  templates as templateSchema,
  type Deployment,
  type PublishTarget,
} from "@webstudio-is/sdk";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import {
  and,
  build,
  desc,
  domain as domainTable,
  eq,
  isNotNull,
  maybeOne,
} from "@webstudio-is/db";
import { db } from "./db";
import { validateDomain } from "./db/validate";

type LoadedProject = Awaited<ReturnType<typeof projectApi.loadById>>;
type ProjectDomain = LoadedProject["domainsVirtual"][number];

const assertMutation = (result: { success: boolean; error?: string }) => {
  if (result.success === false) {
    throw new Error(result.error ?? "Domain operation failed");
  }
};

const serializeProjectDomain = (domain: ProjectDomain) => ({
  id: domain.domainId,
  domain: domain.domain,
  status: domain.status,
  verified: domain.verified,
  txtRecord: domain.domainTxtRecord ?? undefined,
  expectedTxtRecord: domain.expectedTxtRecord,
  cname: domain.cname,
  error: domain.error ?? undefined,
  createdAt: domain.createdAt,
  updatedAt: domain.updatedAt,
});

const getProjectDomainOrThrow = (
  project: LoadedProject,
  predicate: (domain: ProjectDomain) => boolean
) => {
  const domain = project.domainsVirtual.find(predicate);
  if (domain === undefined) {
    throw new Error("Domain not found");
  }
  return domain;
};

export const getDefaultPublishDomains = (
  project: LoadedProject,
  target: PublishTarget
) => {
  if (target === "staging") {
    return [project.domain];
  }
  return [
    project.domain,
    ...project.domainsVirtual
      .filter((domain) => domain.status === "ACTIVE" && domain.verified)
      .map((domain) => domain.domain),
  ];
};

export const getPublishTargetForDomains = (
  project: LoadedProject,
  domains: string[]
): PublishTarget =>
  domains.some((domain) => domain !== project.domain)
    ? "production"
    : "staging";

export const getVerifiedPublishDomains = (
  project: LoadedProject,
  domains: string[]
) => {
  const currentProjectDomains = project.domainsVirtual;
  const verifiedDomains: string[] = [];

  if (domains.includes(project.domain)) {
    verifiedDomains.push(project.domain);
  }

  verifiedDomains.push(
    ...domains.filter((domain) =>
      currentProjectDomains.some(
        (projectDomain) =>
          projectDomain.domain === domain &&
          projectDomain.status === "ACTIVE" &&
          projectDomain.verified
      )
    )
  );

  return verifiedDomains;
};

export const listProjectPublishes = async (
  projectId: string,
  context: AppContext
) => {
  const builds = await context.db
    .select({
      id: build.id,
      version: build.version,
      createdAt: build.createdAt,
      deployment: build.deployment,
    })
    .from(build)
    .where(and(eq(build.projectId, projectId), isNotNull(build.deployment)))
    .orderBy(desc(build.createdAt));

  return {
    publishes: builds.flatMap((build) => {
      const deployment = parseDeployment(build.deployment);
      if (deployment === undefined || deployment.destination === "static") {
        return [];
      }
      return [
        {
          id: build.id,
          jobId: build.id,
          version: build.version,
          target: getPublishTarget(deployment),
          domains: deployment.domains,
          createdAt: build.createdAt,
        },
      ];
    }),
  };
};

export const getProjectPublishJob = async (
  input: { projectId: string; jobId: string },
  context: AppContext
) => {
  const publishJob = maybeOne(
    await context.db
      .select({
        id: build.id,
        version: build.version,
        createdAt: build.createdAt,
        updatedAt: build.updatedAt,
        deployment: build.deployment,
        publishStatus: build.publishStatus,
      })
      .from(build)
      .where(
        and(eq(build.projectId, input.projectId), eq(build.id, input.jobId))
      )
  );
  if (publishJob === null) {
    return undefined;
  }

  const deployment = parseDeployment(publishJob.deployment);
  const status =
    deployment === undefined
      ? "removed"
      : publishJob.publishStatus === "PUBLISHED"
        ? "success"
        : publishJob.publishStatus === "FAILED"
          ? "failed"
          : "pending";
  return {
    id: publishJob.id,
    version: publishJob.version,
    status,
    target:
      deployment !== undefined && deployment.destination !== "static"
        ? getPublishTarget(deployment)
        : undefined,
    domains:
      deployment !== undefined && deployment.destination !== "static"
        ? deployment.domains
        : [],
    createdAt: publishJob.createdAt,
    completedAt:
      status === "success" || status === "failed"
        ? publishJob.updatedAt
        : undefined,
  };
};

const createPublishedDeployment = ({
  project,
  domains,
  target,
}: {
  project: LoadedProject;
  domains: string[];
  target: PublishTarget;
}): Deployment => ({
  destination: publishedDeploymentDestination,
  target,
  domains,
  assetsDomain: project.domain,
  excludeWstdDomainFromSearch: project.domainsVirtual.some(
    (domain) => domain.status === "ACTIVE" && domain.verified
  ),
});

export const publishProject = async (
  {
    project,
    domains,
    target,
  }: {
    project: LoadedProject;
    domains: string[];
    target: PublishTarget;
  },
  context: AppContext
) => {
  const build = await createProductionBuild(
    {
      projectId: project.id,
      deployment: createPublishedDeployment({
        project,
        domains,
        target,
      }),
    },
    context
  );
  // selfhost: the project's deployer (its deploy target) builds and deploys it, then
  // reports the result to the builder.
  const result = await context.deployment.deployments.publish({
    projectId: project.id,
    buildId: build.id,
    label: `${project.title} - ${project.id}`,
  });
  if (result.success === false) {
    throw new Error(result.error);
  }

  return { build, project, deploymentNotImplemented: false };
};

/**
 * selfhost: Export's static download. The builder builds and zips the site in the background
 * (apps/builder static-export.server.ts); the client polls the build and then downloads
 * /cgi/static/ssg/<name>.
 */
export const publishStaticProject = async (
  {
    projectId,
    templates,
  }: {
    projectId: string;
    templates: z.infer<typeof templateSchema>[];
  },
  context: AppContext
): Promise<
  { success: true; name: string } | { success: false; error: string }
> => {
  // Only the static site templates build a download.
  if (templates.some((template) => template.startsWith("ssg") === false)) {
    return { success: false, error: "Only static site templates download" };
  }
  const project = await projectApi.loadById(projectId, context);
  const build = await createProductionBuild(
    {
      projectId,
      deployment: {
        destination: "static",
        name: project.domain,
        assetsDomain: project.domain,
        templates,
      },
    },
    context
  );
  const result = await context.deployment.deployments.exportStatic({
    projectId,
    buildId: build.id,
    templates,
  });
  if (result.success === false) {
    return result;
  }
  return { success: true, name: `${build.id}.zip` };
};

export const unpublishProjectDomains = async (
  {
    projectId,
    domains,
  }: {
    projectId: string;
    domains: string[];
  },
  context: AppContext
) => {
  const { deployments, env } = context.deployment;

  for (const domain of domains) {
    const dbDomain = domain.replace(`.${env.PUBLISHER_HOST}`, "");
    // selfhost: the project's own domain stands for its site at its deploy target.
    // Custom domains point at that site from the user's DNS, so there's nothing to remove.
    const result =
      dbDomain === domain
        ? ({ success: true } as const)
        : await deployments.unpublish({ projectId });
    await unpublishBuild({ projectId, domain: dbDomain }, context).catch(
      (error) => {
        if (
          error instanceof Error &&
          error.message === `Domain ${dbDomain} is not published`
        ) {
          return;
        }
        throw error;
      }
    );
    if (result.success === false) {
      throw new Error(`Failed to unpublish ${domain}: ${result.error}`);
    }
  }
};

export const listProjectDomains = async (
  projectId: string,
  context: AppContext
) => {
  const project = await projectApi.loadById(projectId, context);
  return project.domainsVirtual.map(serializeProjectDomain);
};

export const createProjectDomain = async (
  input: { projectId: string; domain: string },
  context: AppContext
) => {
  assertMutation(await createProjectDomainResult(input, context));
  const project = await projectApi.loadById(input.projectId, context);
  const validation = validateDomain(input.domain);
  const domain =
    validation.success === true
      ? validation.domain
      : input.domain.toLowerCase();
  return serializeProjectDomain(
    getProjectDomainOrThrow(project, (item) => item.domain === domain)
  );
};

export const createProjectDomainResult = async (
  input: { projectId: string; domain: string },
  context: AppContext
) => {
  return await db.create(input, context);
};

export const updateProjectDomain = async (
  input: {
    projectId: string;
    domainId: string;
    updates: { domain?: string };
  },
  context: AppContext
) => {
  const project = await projectApi.loadById(input.projectId, context);
  getProjectDomainOrThrow(
    project,
    (domain) => domain.domainId === input.domainId
  );

  if (input.updates.domain !== undefined) {
    const validation = validateDomain(input.updates.domain);
    if (validation.success === false) {
      throw new Error(validation.error);
    }
    await context.db
      .update(domainTable)
      .set({
        domain: validation.domain,
        status: "INITIALIZING",
        error: null,
        txtRecord: null,
      })
      .where(eq(domainTable.id, input.domainId));
  }

  const updatedProject = await projectApi.loadById(input.projectId, context);
  return serializeProjectDomain(
    getProjectDomainOrThrow(
      updatedProject,
      (domain) => domain.domainId === input.domainId
    )
  );
};

export const deleteProjectDomain = async (
  input: { projectId: string; domainId: string },
  context: AppContext
) => {
  assertMutation(await deleteProjectDomainResult(input, context));
  return { status: "deleted" as const };
};

export const deleteProjectDomainResult = async (
  input: { projectId: string; domainId: string },
  context: AppContext
) => {
  return await db.remove(input, context);
};

export const verifyProjectDomain = async (
  input: { projectId: string; domainId: string },
  context: AppContext
) => {
  assertMutation(await verifyProjectDomainResult(input, context));
  const project = await projectApi.loadById(input.projectId, context);
  return serializeProjectDomain(
    getProjectDomainOrThrow(
      project,
      (domain) => domain.domainId === input.domainId
    )
  );
};

export const verifyProjectDomainResult = async (
  input: { projectId: string; domainId: string },
  context: AppContext
) => {
  return await db.verify(input, context);
};

export const createUnpublishJobId = () => `unpublish-${createId("nano")}`;
