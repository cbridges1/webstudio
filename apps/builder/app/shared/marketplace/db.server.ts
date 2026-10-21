import { marketplaceProduct } from "@webstudio-is/project-build";
import type { MarketplaceOverviewItem } from "./types";
import { loadApprovedProdBuildByProjectId } from "@webstudio-is/project-build/server";
import { parseConfig } from "@webstudio-is/project-build/persistence";
import type { AppContext } from "@webstudio-is/trpc-interface/index.server";
import type { Project } from "@webstudio-is/project";
import { loadAssetsByProject } from "@webstudio-is/asset-uploader/server";
import { serializePages } from "@webstudio-is/project-migrations/pages";
import { approvedMarketplaceProduct, asset, inArray } from "@webstudio-is/db";

export const getBuildProdData = async (
  { projectId }: { projectId: Project["id"] },
  context: AppContext
) => {
  const build = await loadApprovedProdBuildByProjectId(context, projectId);

  const assets = await loadAssetsByProject(projectId, context, {
    skipPermissionsCheck: true,
  });

  return {
    ...build,
    pages: serializePages(build.pages),
    assets,
  };
};

export const getItems = async (
  context: AppContext
): Promise<Array<MarketplaceOverviewItem>> => {
  const approvedMarketplaceProducts = await context.db
    .select()
    .from(approvedMarketplaceProduct);

  const items: MarketplaceOverviewItem[] = [];

  for (const product of approvedMarketplaceProducts) {
    if (product.marketplaceProduct === null || product.projectId === null) {
      continue;
    }
    const parsedProduct = marketplaceProduct.safeParse(
      parseConfig(product.marketplaceProduct)
    );

    if (parsedProduct.success === false) {
      console.error(parsedProduct.error.flatten().fieldErrors);
      continue;
    }

    items.push({
      projectId: product.projectId,
      authorizationToken: product.authorizationToken ?? undefined,
      ...parsedProduct.data,
    });
  }
  const assetIds = items
    .map((item) => item.thumbnailAssetId)
    .filter((value): value is string => value != null);

  const assets = new Map<string, string>();
  if (assetIds.length > 0) {
    const rows = await context.db
      .select({ id: asset.id, name: asset.name })
      .from(asset)
      .where(inArray(asset.id, assetIds));
    for (const row of rows) {
      assets.set(row.id, row.name);
    }
  }

  return items.map((item) => {
    return {
      ...item,
      thumbnailAssetName: assets.get(item.thumbnailAssetId),
    };
  });
};
