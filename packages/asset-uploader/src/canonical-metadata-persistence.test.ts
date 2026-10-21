import { describe, expect, test } from "vitest";
import {
  canonicalAssetMetadataExtractorGeneration,
  createCanonicalAssetFileEntry,
} from "@webstudio-is/content-engine/compiler";
import { asset, assetFileMetadata, eq, file, type Db } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import {
  deleteCanonicalAssetFileEntryIfMatches,
  deleteStaleCanonicalAssetFileEntries,
  loadCanonicalAssetFileEntries,
  replaceCanonicalAssetFileEntry,
} from "./canonical-metadata-persistence";

const db = setupTestDb();
const document = {
  _id: "asset-1",
  _type: "asset.file" as const,
  name: "post.md",
  path: "blog/post.md",
  key: "post",
  folderId: "blog",
  extension: "md",
  mimeType: "text/markdown",
  size: 100,
  revision: "sha256:one",
  contentRef: "asset:post.md:sha256:one",
  properties: { title: "Post" },
  excerpt: "Post excerpt",
};
const entry = createCanonicalAssetFileEntry({
  projectId: "project-1",
  document,
});
const storedDocument = {
  ...document,
  $webstudioMetadataRequirements: "properties+excerpt",
  $webstudioExtractorGeneration: canonicalAssetMetadataExtractorGeneration,
};
const row = {
  ...entry,
  document: storedDocument,
  createdAt: "2026-07-18T00:00:00.000Z",
  updatedAt: "2026-07-18T00:00:00.000Z",
};

const loadEntry = async (client: Db = db) =>
  (
    await loadCanonicalAssetFileEntries({
      client,
      projectId: "project-1",
    })
  )[0];

/** A database answering every metadata query with `rows`. */
const createDbReturning = (rows: unknown[]) =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ orderBy: async () => rows }),
      }),
    }),
  }) as unknown as Db;

const source = {
  storageName: "stored.md",
  fileUpdatedAt: "2026-07-18T00:00:00.000Z",
  fileSize: 100,
  contentHash: "a".repeat(64),
  filename: "post.md",
  description: "Summary",
  folderId: "blog",
};

/** asset-1 of project-1, pointing at the uploaded file `source` describes. */
const seedSourceAsset = async () => {
  await seed.project(db, { id: "project-1", userId: "user-1" });
  await seed.assetFolder(db, { id: "blog", projectId: "project-1" });
  await seed.asset(
    db,
    {
      id: "asset-1",
      projectId: "project-1",
      name: source.storageName,
      filename: source.filename,
      description: source.description,
      folderId: source.folderId,
    },
    {
      size: source.fileSize,
      updatedAt: source.fileUpdatedAt,
      contentHash: source.contentHash,
    }
  );
};

const storedRows = async () => await db.select().from(assetFileMetadata);

describe("canonical asset metadata persistence", () => {
  test("stores metadata while the asset still matches its source", async () => {
    await seedSourceAsset();

    await expect(
      replaceCanonicalAssetFileEntry({ client: db, entry, source })
    ).resolves.toEqual(entry);

    expect(await storedRows()).toEqual([
      expect.objectContaining({
        projectId: "project-1",
        assetId: "asset-1",
        revision: "sha256:one",
        document: storedDocument,
      }),
    ]);
  });

  test("replaces older revisions for one canonical asset", async () => {
    await seedSourceAsset();
    const older = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document: { ...document, revision: "sha256:zero" },
    });
    await replaceCanonicalAssetFileEntry({ client: db, entry: older, source });

    await replaceCanonicalAssetFileEntry({ client: db, entry, source });

    expect(await storedRows()).toEqual([
      expect.objectContaining({ revision: "sha256:one" }),
    ]);
  });

  test("rejects a replacement when its source snapshot is stale", async () => {
    await seedSourceAsset();
    // The asset was renamed after its metadata was extracted.
    await db
      .update(asset)
      .set({ filename: "renamed.md" })
      .where(eq(asset.id, "asset-1"));

    await expect(
      replaceCanonicalAssetFileEntry({ client: db, entry, source })
    ).rejects.toThrow("source changed during update");
    expect(await storedRows()).toEqual([]);
  });

  test("rejects a replacement when the file is no longer uploaded", async () => {
    await seedSourceAsset();
    await db
      .update(file)
      .set({ status: "UPLOADING" })
      .where(eq(file.name, source.storageName));

    await expect(
      replaceCanonicalAssetFileEntry({ client: db, entry, source })
    ).rejects.toThrow("source changed during update");
  });

  test("loads project entries in deterministic key order", async () => {
    await seedSourceAsset();
    await seed.asset(db, {
      id: "asset-0",
      projectId: "project-1",
      name: "zero.md",
    });
    const first = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document: { ...document, _id: "asset-0", contentRef: "asset:zero.md" },
    });
    await db.insert(assetFileMetadata).values([
      { ...entry, document: storedDocument },
      {
        ...first,
        document: {
          ...first.document,
          $webstudioMetadataRequirements: "properties+excerpt",
          $webstudioExtractorGeneration:
            canonicalAssetMetadataExtractorGeneration,
        },
      },
    ]);

    await expect(
      loadCanonicalAssetFileEntries({ client: db, projectId: "project-1" })
    ).resolves.toEqual([first, entry]);
  });

  test("loads cached metadata requirements without exposing the storage marker", async () => {
    const loaded = await loadEntry(
      createDbReturning([
        {
          ...row,
          document: {
            ...document,
            properties: {},
            $webstudioMetadataRequirements: "excerpt",
            $webstudioExtractorGeneration:
              canonicalAssetMetadataExtractorGeneration,
          },
        },
      ])
    );

    expect(loaded?.metadataRequirements).toEqual({
      structuredProperties: false,
      excerpt: true,
    });
    expect(loaded?.document).not.toHaveProperty(
      "$webstudioMetadataRequirements"
    );
    expect(loaded?.document).not.toHaveProperty(
      "$webstudioExtractorGeneration"
    );
  });

  test("treats metadata from an older extractor generation as unprepared", async () => {
    const loaded = await loadEntry(
      createDbReturning([
        {
          ...row,
          document: {
            ...storedDocument,
            $webstudioExtractorGeneration:
              canonicalAssetMetadataExtractorGeneration - 1,
          },
        },
      ])
    );

    expect(loaded?.metadataRequirements).toEqual({
      structuredProperties: false,
      excerpt: false,
    });
    expect(loaded?.document.properties).toEqual({});
    expect(loaded?.document).not.toHaveProperty("excerpt");
    expect(loaded?.document).not.toHaveProperty("metadataError");
  });

  test("treats metadata without an extractor generation as unprepared", async () => {
    const {
      $webstudioExtractorGeneration: _extractorGeneration,
      ...legacyDocument
    } = storedDocument;

    const loaded = await loadEntry(
      createDbReturning([{ ...row, document: legacyDocument }])
    );

    expect(loaded?.metadataRequirements).toEqual({
      structuredProperties: false,
      excerpt: false,
    });
  });

  test("rejects rows whose database and document identities disagree", async () => {
    // The table's check constraint prevents this; the loader checks anyway.
    await expect(
      loadEntry(createDbReturning([{ ...row, assetId: "asset-2" }]))
    ).rejects.toThrow("identity is inconsistent");
  });

  test("deletes stale metadata only for the selected assets without uploaded files", async () => {
    await seedSourceAsset();
    await seed.asset(
      db,
      { id: "asset-2", projectId: "project-1", name: "two.md" },
      { status: "UPLOADING" }
    );
    const second = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document: { ...document, _id: "asset-2", contentRef: "asset:two.md" },
    });
    await db.insert(assetFileMetadata).values([
      { ...entry, document: storedDocument },
      { ...second, document: { ...second.document } },
    ]);

    await expect(
      deleteStaleCanonicalAssetFileEntries({
        client: db,
        projectId: "project-1",
        assetIds: ["asset-2", "asset-1", "asset-2"],
      })
    ).resolves.toBe(1);
    expect((await storedRows()).map((stored) => stored.assetId)).toEqual([
      "asset-1",
    ]);
  });

  test("deletes standard metadata only when the complete snapshot still matches", async () => {
    await seedSourceAsset();
    await replaceCanonicalAssetFileEntry({ client: db, entry, source });

    const changed = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document: { ...document, properties: { title: "Changed" } },
    });
    await expect(
      deleteCanonicalAssetFileEntryIfMatches({ client: db, entry: changed })
    ).resolves.toBe(0);
    await expect(
      deleteCanonicalAssetFileEntryIfMatches({ client: db, entry })
    ).resolves.toBe(1);
    expect(await storedRows()).toEqual([]);
  });
});
