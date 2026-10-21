import {
  canonicalAssetMetadataExtractorGeneration,
  createCanonicalAssetFileEntry,
  fullCanonicalAssetMetadataRequirements,
  getCanonicalAssetMetadataRequirements,
  getCanonicalAssetMetadataRequirementsForTier,
  getCanonicalAssetMetadataTier,
  type CanonicalAssetFileEntry,
} from "@webstudio-is/content-engine/compiler";
import {
  and,
  asc,
  asset,
  assetFileMetadata,
  eq,
  file,
  inArray,
  sql,
  type Database,
  type Db,
} from "@webstudio-is/db";

type MetadataRow = Database["public"]["Tables"]["AssetFileMetadata"]["Row"];

const requirementsKey = "$webstudioMetadataRequirements";
const extractorGenerationKey = "$webstudioExtractorGeneration";

// Keep cache completeness in the stored document envelope so expanding
// requirements can reuse a matching revision. The marker is stripped before
// schema validation and never reaches query indexes or results.
const serializeMetadataDocument = (entry: CanonicalAssetFileEntry) => ({
  ...entry.document,
  [requirementsKey]: getCanonicalAssetMetadataTier(
    getCanonicalAssetMetadataRequirements(entry)
  ),
  [extractorGenerationKey]: canonicalAssetMetadataExtractorGeneration,
});

export type CanonicalAssetMetadataSource = {
  storageName: string;
  fileUpdatedAt: string;
  fileSize: number;
  contentHash?: string;
  filename?: string;
  description?: string;
  folderId?: string;
};

const parseMetadataRow = (row: MetadataRow): CanonicalAssetFileEntry => {
  if (
    typeof row.document !== "object" ||
    row.document === null ||
    Array.isArray(row.document)
  ) {
    throw new Error("Canonical asset metadata document is invalid");
  }
  const {
    [requirementsKey]: requirements,
    [extractorGenerationKey]: extractorGeneration,
    ...document
  } = row.document;
  const extractorIsCurrent =
    extractorGeneration === canonicalAssetMetadataExtractorGeneration;
  let documentForEntry = document;
  if (extractorIsCurrent === false) {
    const {
      properties: _properties,
      excerpt: _excerpt,
      metadataError: _metadataError,
      ...baseDocument
    } = document;
    documentForEntry = { ...baseDocument, properties: {} };
  }
  const entry = createCanonicalAssetFileEntry({
    projectId: row.projectId,
    document: documentForEntry,
    metadataRequirements: extractorIsCurrent
      ? requirements === undefined
        ? fullCanonicalAssetMetadataRequirements
        : getCanonicalAssetMetadataRequirementsForTier(requirements)
      : { structuredProperties: false, excerpt: false },
  });
  if (entry.assetId !== row.assetId || entry.revision !== row.revision) {
    throw new Error("Canonical asset metadata identity is inconsistent");
  }
  return entry;
};

/**
 * Serializes metadata writes for one asset until the transaction ends, across
 * every process sharing the database.
 */
const lockAssetMetadata = async (
  tx: Db,
  projectId: string,
  assetId: string
) => {
  await tx.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(pg_catalog.jsonb_build_array(${projectId}::text, ${assetId}::text)::text, 0))`
  );
};

/** The asset still points at an uploaded file. */
const hasUploadedFile = (projectId: string, assetId: string) =>
  and(
    eq(asset.projectId, projectId),
    eq(asset.id, assetId),
    eq(file.status, "UPLOADED")
  );

const isNotDistinctFrom = (
  column:
    | typeof asset.filename
    | typeof asset.description
    | typeof asset.folderId,
  value: string | null
) => sql`${column} IS NOT DISTINCT FROM ${value}`;

export const replaceCanonicalAssetFileEntry = async ({
  client,
  entry,
  source,
}: {
  client: Db;
  entry: CanonicalAssetFileEntry;
  source: CanonicalAssetMetadataSource;
}): Promise<CanonicalAssetFileEntry> => {
  if (
    entry.document._id !== entry.assetId ||
    entry.document.revision !== entry.revision
  ) {
    throw new Error("Canonical asset metadata identity is inconsistent");
  }
  const document = serializeMetadataDocument(entry);
  // Store the metadata only while the asset still has the file and fields it was
  // extracted from.
  const replaced = await client.transaction(async (tx) => {
    await lockAssetMetadata(tx, entry.projectId, entry.assetId);
    const current = await tx
      .select({ id: asset.id })
      .from(asset)
      .innerJoin(file, eq(file.name, asset.name))
      .where(
        and(
          hasUploadedFile(entry.projectId, entry.assetId),
          isNotDistinctFrom(asset.filename, source.filename ?? null),
          isNotDistinctFrom(asset.description, source.description ?? null),
          isNotDistinctFrom(asset.folderId, source.folderId ?? null),
          eq(file.name, source.storageName),
          sql`${file.updatedAt} = ${source.fileUpdatedAt}::timestamptz`,
          eq(file.size, source.fileSize)
        )
      )
      .for("update", { of: [asset, file] });
    if (current.length === 0) {
      return false;
    }
    await tx
      .insert(assetFileMetadata)
      .values({
        projectId: entry.projectId,
        assetId: entry.assetId,
        revision: entry.revision,
        document,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      })
      .onConflictDoUpdate({
        target: [assetFileMetadata.projectId, assetFileMetadata.assetId],
        set: {
          revision: sql`excluded.revision`,
          document: sql`excluded.document`,
          updatedAt: sql`excluded."updatedAt"`,
        },
        setWhere: sql`${assetFileMetadata.revision} IS DISTINCT FROM excluded.revision OR ${assetFileMetadata.document} IS DISTINCT FROM excluded.document`,
      });
    return true;
  });
  if (replaced !== true) {
    throw new Error("Canonical asset metadata source changed during update");
  }
  return entry;
};

export const deleteStaleCanonicalAssetFileEntries = async ({
  client,
  projectId,
  assetIds,
}: {
  client: Db;
  projectId: string;
  assetIds: string[];
}) => {
  if (assetIds.length === 0) {
    return 0;
  }
  // Lock in a stable order so concurrent calls can't deadlock.
  const sortedAssetIds = [...new Set(assetIds)].sort();
  return await client.transaction(async (tx) => {
    let deleted = 0;
    for (const assetId of sortedAssetIds) {
      await lockAssetMetadata(tx, projectId, assetId);
      const current = await tx
        .select({ id: asset.id })
        .from(asset)
        .innerJoin(file, eq(file.name, asset.name))
        .where(hasUploadedFile(projectId, assetId))
        .limit(1);
      if (current.length > 0) {
        continue;
      }
      const rows = await tx
        .delete(assetFileMetadata)
        .where(
          and(
            eq(assetFileMetadata.projectId, projectId),
            eq(assetFileMetadata.assetId, assetId)
          )
        )
        .returning({ assetId: assetFileMetadata.assetId });
      deleted += rows.length;
    }
    return deleted;
  });
};

export const deleteInvalidCanonicalAssetFileEntryIfMatches = async ({
  client,
  row,
}: {
  client: Db;
  row: Pick<MetadataRow, "projectId" | "assetId" | "revision" | "document">;
}) => {
  return await client.transaction(async (tx) => {
    await lockAssetMetadata(tx, row.projectId, row.assetId);
    const deleted = await tx
      .delete(assetFileMetadata)
      .where(
        and(
          eq(assetFileMetadata.projectId, row.projectId),
          eq(assetFileMetadata.assetId, row.assetId),
          eq(assetFileMetadata.revision, row.revision),
          sql`${assetFileMetadata.document} = ${JSON.stringify(row.document)}::jsonb`
        )
      )
      .returning({ assetId: assetFileMetadata.assetId });
    return deleted.length;
  });
};

export const deleteCanonicalAssetFileEntryIfMatches = async ({
  client,
  entry,
}: {
  client: Db;
  entry: CanonicalAssetFileEntry;
}) =>
  await deleteInvalidCanonicalAssetFileEntryIfMatches({
    client,
    row: { ...entry, document: serializeMetadataDocument(entry) },
  });

const loadCanonicalAssetFileMetadataRows = async ({
  client,
  projectId,
  assetIds,
}: {
  client: Db;
  projectId: string;
  assetIds?: string[];
}): Promise<MetadataRow[]> => {
  if (assetIds?.length === 0) {
    return [];
  }
  return await client
    .select()
    .from(assetFileMetadata)
    .where(
      and(
        eq(assetFileMetadata.projectId, projectId),
        assetIds === undefined
          ? undefined
          : inArray(assetFileMetadata.assetId, assetIds)
      )
    )
    .orderBy(asc(assetFileMetadata.assetId));
};

export const loadCanonicalAssetFileEntries = async ({
  client,
  projectId,
  assetIds,
}: {
  client: Db;
  projectId: string;
  assetIds?: string[];
}): Promise<CanonicalAssetFileEntry[]> => {
  const rows = await loadCanonicalAssetFileMetadataRows({
    client,
    projectId,
    assetIds,
  });
  return rows.map(parseMetadataRow);
};

export const loadCanonicalAssetFileEntriesForRecovery = async ({
  client,
  projectId,
  assetIds,
}: {
  client: Db;
  projectId: string;
  assetIds?: string[];
}) => {
  const rows = await loadCanonicalAssetFileMetadataRows({
    client,
    projectId,
    assetIds,
  });
  const entries: CanonicalAssetFileEntry[] = [];
  const inconsistentRows: Array<
    Pick<MetadataRow, "projectId" | "assetId" | "revision" | "document">
  > = [];
  for (const row of rows) {
    try {
      entries.push(parseMetadataRow(row));
    } catch {
      inconsistentRows.push(row);
    }
  }
  return {
    entries,
    inconsistentRows,
  };
};
