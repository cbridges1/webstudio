import { z } from "zod";

/**
 * Feature switches and limits that upstream Webstudio sells as plans.
 *
 * selfhost: this fork has no pricing model. Every account gets every feature
 * with no limits (see defaultPlanFeatures). The shape stays so the checks that
 * read it keep working unchanged.
 */
export const planFeatures = z.object({
  canDownloadAssets: z.boolean(),
  canRestoreBackups: z.boolean(),
  allowAdditionalPermissions: z.boolean(),
  allowDynamicData: z.boolean(),
  allowAuth: z.boolean(),
  allowContentMode: z.boolean(),
  allowStagingPublish: z.boolean(),
  maxContactEmailsPerProject: z.number().nonnegative(),
  maxDomainsAllowedPerUser: z.number().nonnegative(),
  maxDailyPublishesPerUser: z.number().nonnegative(),
  maxWorkspaces: z.number().nonnegative(),
  maxProjectsAllowedPerUser: z.number().nonnegative(),
  maxAssetsPerProject: z.number().nonnegative(),
  seatsIncluded: z.number().nonnegative(),
  maxSeatsPerWorkspace: z.number().nonnegative(),
});

export type PlanFeatures = z.infer<typeof planFeatures>;

// Compile-time guard: all PlanFeatures values must be boolean or number.
// If a new field with a different type is added to planFeatures, this line will error.
type _AssertBooleanOrNumber =
  PlanFeatures extends Record<string, boolean | number> ? true : never;
const _checkPlanFeaturesValueTypes: _AssertBooleanOrNumber = true;
void _checkPlanFeaturesValueTypes;

/**
 * Stands in for "no limit". A finite number, unlike Infinity, survives JSON
 * serialization to the client.
 */
export const unlimited = Number.MAX_SAFE_INTEGER;

/** Returns true when a numeric limit is effectively unlimited. */
export const isUnlimited = (limit: number) => limit >= unlimited;

/** Every feature enabled, every limit unlimited. */
export const defaultPlanFeatures: PlanFeatures = {
  canDownloadAssets: true,
  canRestoreBackups: true,
  allowAdditionalPermissions: true,
  allowDynamicData: true,
  allowAuth: true,
  allowContentMode: true,
  allowStagingPublish: true,
  maxContactEmailsPerProject: unlimited,
  maxDomainsAllowedPerUser: unlimited,
  maxDailyPublishesPerUser: unlimited,
  maxWorkspaces: unlimited,
  maxProjectsAllowedPerUser: unlimited,
  maxAssetsPerProject: unlimited,
  seatsIncluded: unlimited,
  maxSeatsPerWorkspace: unlimited,
};

/**
 * Upstream's record of a bought plan. selfhost: nothing is sold, so purchase
 * lists are always empty; the type remains for code shared with upstream.
 */
export type Purchase = {
  planName: string;
  subscriptionId?: string;
};
