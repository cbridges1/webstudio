import { describe, expect, test, vi } from "vitest";
import {
  canonicalAssetMetadataExtractorGeneration,
  createCanonicalAssetFileEntry,
  getCanonicalAssetMetadataTier,
  type CanonicalAssetFileEntry,
} from "@webstudio-is/content-engine/compiler";
import { assetFileMetadata, type Json } from "@webstudio-is/db";
import { seed, setupTestDb } from "@webstudio-is/db/testing";
import type { AssetObjectStore } from "./client";
import {
  areCanonicalAssetFileEntriesCurrent,
  loadCanonicalAssetBaseEntries,
  synchronizeCanonicalAssets,
} from "./canonical-metadata-backfill";

const db = setupTestDb();
const encoder = new TextEncoder();

type AssetRow = {
  id: string;
  filename?: string | null;
  description?: string | null;
  folderId?: string | null;
  file: {
    name: string;
    size: number;
    updatedAt: string;
    contentHash?: string;
    status?: "UPLOADING" | "UPLOADED";
  };
};

/** project-1 with the given folders and assets. */
const seedProject = async ({
  folders = [],
  assets = [],
}: {
  folders?: Array<{ id: string; name: string; parentId?: string }>;
  assets?: AssetRow[];
}) => {
  await seed.project(db, { id: "project-1", userId: "user-1" });
  for (const folder of folders) {
    await seed.assetFolder(db, {
      ...folder,
      projectId: "project-1",
      createdAt: "2026-07-18T00:00:00.000Z",
    });
  }
  for (const { file, ...row } of assets) {
    await seed.asset(
      db,
      { ...row, projectId: "project-1", name: file.name },
      {
        createdAt: "2026-07-18T00:00:00.000Z",
        ...file,
        status: file.status ?? "UPLOADED",
      }
    );
  }
};

/** Stores metadata as a previous synchronization would have. */
const seedMetadata = async (
  entries: CanonicalAssetFileEntry[],
  requirementsTier = "properties+excerpt"
) => {
  await db.insert(assetFileMetadata).values(
    entries.map((entry) => ({
      projectId: entry.projectId,
      assetId: entry.assetId,
      revision: entry.revision,
      document: {
        ...entry.document,
        $webstudioMetadataRequirements: requirementsTier,
        $webstudioExtractorGeneration:
          canonicalAssetMetadataExtractorGeneration,
      } as Json,
    }))
  );
};

const storedDocuments = async () =>
  new Map(
    (await db.select().from(assetFileMetadata)).map((row) => [
      row.assetId,
      row.document as Record<string, unknown>,
    ])
  );

describe("canonical asset metadata synchronization", () => {
  test("recognizes metadata that already matches the source snapshot", () => {
    const document = {
      _id: "post",
      _type: "asset.file" as const,
      name: "post.md",
      path: "post.md",
      key: "post",
      extension: "md",
      mimeType: "text/markdown",
      size: 20,
      revision: "revision-1",
      contentRef: "post.md",
      properties: {},
    };
    const base = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document,
      metadataRequirements: { structuredProperties: false, excerpt: false },
    });
    const current = createCanonicalAssetFileEntry({
      projectId: "project-1",
      document: {
        ...document,
        properties: { title: "Post" },
        excerpt: "Post body",
      },
      metadataRequirements: { structuredProperties: true, excerpt: true },
    });

    expect(
      areCanonicalAssetFileEntriesCurrent({
        baseEntries: [base],
        currentEntries: [current],
        requirements: { structuredProperties: true, excerpt: false },
      })
    ).toBe(true);
    expect(
      areCanonicalAssetFileEntriesCurrent({
        baseEntries: [{ ...base, revision: "revision-2" }],
        currentEntries: [current],
        requirements: { structuredProperties: true, excerpt: false },
      })
    ).toBe(false);
    expect(
      areCanonicalAssetFileEntriesCurrent({
        baseEntries: [
          {
            ...base,
            document: { ...base.document, path: "archive/post.md" },
          },
        ],
        currentEntries: [current],
        requirements: { structuredProperties: true, excerpt: false },
      })
    ).toBe(false);
    expect(
      areCanonicalAssetFileEntriesCurrent({
        baseEntries: [base],
        currentEntries: [],
        requirements: { structuredProperties: true, excerpt: false },
      })
    ).toBe(false);
  });

  test("builds base documents from records without canonical writes or object reads", async () => {
    await seedProject({
      folders: [{ id: "blog", name: "Blog" }],
      assets: [
        {
          id: "post",
          filename: "Hello",
          folderId: "blog",
          file: {
            name: "stored-post.md",
            size: 20,
            updatedAt: "2026-07-18T01:00:00.000Z",
            contentHash: "a".repeat(64),
          },
        },
      ],
    });

    await expect(
      loadCanonicalAssetBaseEntries({ projectId: "project-1", client: db })
    ).resolves.toEqual([
      expect.objectContaining({
        assetId: "post",
        document: expect.objectContaining({
          name: "Hello.md",
          path: "Blog/Hello.md",
          contentRef: "stored-post.md",
          revision: `sha256:${"a".repeat(64)}`,
          properties: {},
        }),
      }),
    ]);
    expect(await storedDocuments()).toEqual(new Map());
  });

  test.each([
    {
      name: "structured properties",
      requirements: { structuredProperties: true, excerpt: false },
      expectedProperties: { title: "Post" },
      expectedExcerpt: undefined,
    },
    {
      name: "excerpt",
      requirements: { structuredProperties: false, excerpt: true },
      expectedProperties: {},
      expectedExcerpt: "Post body",
    },
  ])("prepares only requested Markdown $name", async (scenario) => {
    const source = "---\ntitle: Post\n---\nPost body";
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async () => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield encoder.encode(source);
        },
      },
    }));
    await seedProject({
      assets: [
        {
          id: "post",
          file: {
            name: "post.md",
            size: encoder.encode(source).byteLength,
            updatedAt: "2026-07-18T01:00:00.000Z",
          },
        },
      ],
    });

    await synchronizeCanonicalAssets({
      projectId: "project-1",
      client: db,
      assetClient: { readFile, uploadFile: vi.fn() },
      requirements: scenario.requirements,
    });

    expect(readFile).toHaveBeenCalledOnce();
    const storedDocument = (await storedDocuments()).get("post");
    expect(storedDocument).toMatchObject({
      properties: scenario.expectedProperties,
      $webstudioMetadataRequirements: getCanonicalAssetMetadataTier(
        scenario.requirements
      ),
      $webstudioExtractorGeneration: canonicalAssetMetadataExtractorGeneration,
    });
    if (scenario.expectedExcerpt === undefined) {
      expect(storedDocument).not.toHaveProperty("excerpt");
    } else {
      expect(storedDocument).toHaveProperty(
        "excerpt",
        scenario.expectedExcerpt
      );
    }
  });

  test("expands a cached metadata tier without reparsing completed dimensions", async () => {
    const source = "---\ntitle: Post\n---\nPost body";
    const bytes = encoder.encode(source);
    const updatedAt = "2026-07-18T01:00:00.000Z";
    const revision = `file:post.md:${updatedAt}:${bytes.byteLength}`;
    const cached = createCanonicalAssetFileEntry({
      projectId: "project-1",
      metadataRequirements: {
        structuredProperties: true,
        excerpt: false,
      },
      document: {
        _id: "post",
        _type: "asset.file",
        name: "post.md",
        path: "post.md",
        key: "post",
        extension: "md",
        mimeType: "text/markdown",
        size: bytes.byteLength,
        revision,
        contentRef: "post.md",
        properties: { title: "Post" },
      },
    });
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async () => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    }));
    await seedProject({
      assets: [
        {
          id: "post",
          file: { name: "post.md", size: bytes.byteLength, updatedAt },
        },
      ],
    });
    await seedMetadata([cached], "properties");

    await synchronizeCanonicalAssets({
      projectId: "project-1",
      client: db,
      assetClient: { uploadFile: vi.fn(), readFile },
      requirements: { structuredProperties: false, excerpt: true },
    });

    expect(readFile).toHaveBeenCalledOnce();
    expect((await storedDocuments()).get("post")).toMatchObject({
      properties: { title: "Post" },
      excerpt: "Post body",
      $webstudioMetadataRequirements: "properties+excerpt",
      $webstudioExtractorGeneration: canonicalAssetMetadataExtractorGeneration,
    });
  });

  test("indexes Markdown and JSON metadata without reading binary files", async () => {
    const contents = new Map([
      ["stored-one.md", "---\ntitle: One\n---\n# First post"],
      ["stored-two.md", "---\ntitle: Two\ndraft: true\n---\nSecond post"],
      ["stored-data.json", '{"title":"Data","draft":false}'],
    ]);
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async (name) => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield encoder.encode(contents.get(name) ?? "");
        },
      },
    }));
    const sizeOf = (name: string) =>
      encoder.encode(contents.get(name)).byteLength;
    await seedProject({
      folders: [
        { id: "content", name: "Content" },
        { id: "blog", name: "Blog", parentId: "content" },
      ],
      assets: [
        {
          id: "one",
          filename: "one",
          folderId: "blog",
          file: {
            name: "stored-one.md",
            size: sizeOf("stored-one.md"),
            updatedAt: "2026-07-18T01:00:00.000Z",
          },
        },
        {
          id: "two",
          file: {
            name: "stored-two.md",
            size: sizeOf("stored-two.md"),
            updatedAt: "2026-07-18T02:00:00.000Z",
          },
        },
        {
          id: "data",
          file: {
            name: "stored-data.json",
            size: sizeOf("stored-data.json"),
            updatedAt: "2026-07-18T02:30:00.000Z",
          },
        },
        {
          id: "image",
          description: "Image description",
          file: {
            name: "image.png",
            size: 20,
            updatedAt: "2026-07-18T03:00:00.000Z",
          },
        },
      ],
    });

    const result = await synchronizeCanonicalAssets({
      projectId: "project-1",
      client: db,
      assetClient: {
        uploadFile: vi.fn(),
        readFile,
      },
      concurrency: 2,
    });

    expect(result).toEqual({
      scanned: 4,
      indexed: 4,
      metadataUpdated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      inconsistent: 0,
      issues: [],
    });
    expect(readFile).toHaveBeenCalledTimes(3);
    const persisted = await storedDocuments();
    expect(persisted.size).toBe(4);
    expect(persisted.get("one")).toMatchObject({
      path: "Content/Blog/one.md",
      properties: { title: "One" },
      excerpt: "First post",
    });
    expect(persisted.get("two")).toMatchObject({
      path: "stored-two.md",
      properties: { title: "Two", draft: true },
      excerpt: "Second post",
    });
    expect(persisted.get("data")).toMatchObject({
      path: "stored-data.json",
      properties: { title: "Data", draft: false },
    });
    expect(persisted.get("image")).toMatchObject({
      path: "image.png",
      description: "Image description",
      properties: {},
    });
    expect(persisted.get("image")).not.toHaveProperty("excerpt");
  });

  test("does not exceed shared read concurrency", async () => {
    await expect(
      synchronizeCanonicalAssets({
        projectId: "project-1",
        client: db,
        assetClient: {
          uploadFile: vi.fn(),
          readFile: vi.fn(),
        },
        concurrency: 9,
      })
    ).rejects.toThrow("exceeds the shared limit");
  });

  test("batch synchronization rereads only missing or changed revisions", async () => {
    const sources = new Map([
      ["changed.md", "---\ntitle: Changed\n---\nChanged body"],
      ["new.md", "---\ntitle: New\n---\nNew body"],
    ]);
    await seedProject({
      assets: [
        {
          id: "stable",
          filename: "stable",
          file: {
            name: "stable.md",
            size: 10,
            updatedAt: "2026-07-18T01:00:00.000Z",
          },
        },
        {
          id: "changed",
          filename: "changed",
          file: {
            name: "changed.md",
            size: encoder.encode(sources.get("changed.md")).byteLength,
            updatedAt: "2026-07-18T02:00:00.000Z",
          },
        },
        {
          id: "renamed",
          filename: "new-name",
          file: {
            name: "renamed.md",
            size: 20,
            updatedAt: "2026-07-18T03:00:00.000Z",
          },
        },
        {
          id: "new",
          file: {
            name: "new.md",
            size: encoder.encode(sources.get("new.md")).byteLength,
            updatedAt: "2026-07-18T04:00:00.000Z",
          },
        },
        {
          id: "image",
          file: {
            name: "image.png",
            size: 30,
            updatedAt: "2026-07-18T05:00:00.000Z",
          },
        },
        // Its file is no longer uploaded, so its metadata is stale.
        {
          id: "stale",
          file: {
            name: "stale.md",
            size: 20,
            updatedAt: "2026-07-18T06:00:00.000Z",
            status: "UPLOADING",
          },
        },
      ],
    });
    const createEntry = ({
      id,
      name,
      revision,
    }: {
      id: string;
      name: string;
      revision: string;
    }) =>
      createCanonicalAssetFileEntry({
        projectId: "project-1",
        document: {
          _id: id,
          _type: "asset.file",
          name,
          path: name,
          key: name.replace(/\.md$/, ""),
          extension: "md",
          mimeType: "text/markdown",
          size: id === "stable" ? 10 : 20,
          createdAt: "2026-07-18T00:00:00.000Z",
          revision,
          contentRef: `${id}.md`,
          properties: { title: id },
          excerpt: `${id} body`,
        },
      });
    const entries = [
      createEntry({
        id: "stable",
        name: "stable.md",
        revision: "file:stable.md:2026-07-18T01:00:00.000Z:10",
      }),
      createEntry({
        id: "changed",
        name: "changed.md",
        revision: "file:changed.md:old:20",
      }),
      createEntry({
        id: "renamed",
        name: "old-name.md",
        revision: "file:renamed.md:2026-07-18T03:00:00.000Z:20",
      }),
      createCanonicalAssetFileEntry({
        projectId: "project-1",
        metadataRequirements: {
          structuredProperties: true,
          excerpt: true,
        },
        document: {
          _id: "image",
          _type: "asset.file",
          name: "image.png",
          path: "image.png",
          key: "image",
          extension: "png",
          mimeType: "image/png",
          size: 30,
          revision: "file:image.png:2026-07-18T05:00:00.000Z:30",
          contentRef: "image.png",
          properties: {},
          excerpt: "Stale excerpt",
        },
      }),
      createEntry({
        id: "stale",
        name: "stale.md",
        revision: "file:stale.md:old:20",
      }),
    ];
    await seedMetadata(entries);
    const before = await db.select().from(assetFileMetadata);
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async (name) => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield encoder.encode(sources.get(name) ?? "");
        },
      },
    }));

    await expect(
      synchronizeCanonicalAssets({
        projectId: "project-1",
        client: db,
        assetClient: { uploadFile: vi.fn(), readFile },
        concurrency: 2,
      })
    ).resolves.toEqual({
      scanned: 5,
      indexed: 2,
      metadataUpdated: 2,
      unchanged: 1,
      removed: 1,
      skipped: 0,
      inconsistent: 0,
      issues: [],
    });
    expect(readFile).toHaveBeenCalledTimes(2);
    expect(readFile.mock.calls.map(([name]) => name).sort()).toEqual([
      "changed.md",
      "new.md",
    ]);
    const after = await storedDocuments();
    expect([...after.keys()].sort()).toEqual([
      "changed",
      "image",
      "new",
      "renamed",
      "stable",
    ]);
    // The unchanged entry is left as it was.
    expect(after.get("stable")).toEqual(
      before.find((row) => row.assetId === "stable")?.document
    );
    expect(after.get("image")).not.toHaveProperty("excerpt");
  });

  test("recovery rereads an inconsistent derived entry", async () => {
    const source = "---\ntitle: Recovered\n---\nRecovered body";
    const bytes = encoder.encode(source);
    const updatedAt = "2026-07-18T06:00:00.000Z";
    const revision = `file:recovery.md:${updatedAt}:${bytes.byteLength}`;
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async () => ({
      data: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    }));
    await seedProject({
      assets: [
        {
          id: "recovery",
          file: { name: "recovery.md", size: bytes.byteLength, updatedAt },
        },
      ],
    });
    // A stored document that no longer parses as a canonical entry.
    await db.insert(assetFileMetadata).values({
      projectId: "project-1",
      assetId: "recovery",
      revision,
      document: { _id: "recovery", revision, _type: "unknown" },
    });

    await expect(
      synchronizeCanonicalAssets({
        projectId: "project-1",
        client: db,
        assetClient: { uploadFile: vi.fn(), readFile },
      })
    ).resolves.toEqual({
      scanned: 1,
      indexed: 1,
      metadataUpdated: 0,
      unchanged: 0,
      removed: 0,
      skipped: 0,
      inconsistent: 1,
      issues: [],
    });
    expect(readFile).toHaveBeenCalledOnce();
    expect((await storedDocuments()).get("recovery")).toMatchObject({
      properties: { title: "Recovered" },
    });
  });

  test("removes invalid derived metadata when source recovery fails", async () => {
    await seedProject({
      assets: [
        {
          id: "broken",
          file: {
            name: "broken.md",
            size: 4,
            updatedAt: "2026-07-18T07:00:00.000Z",
          },
        },
      ],
    });
    await db.insert(assetFileMetadata).values({
      projectId: "project-1",
      assetId: "broken",
      revision: "stale",
      document: { _id: "broken", revision: "stale" },
    });

    const result = await synchronizeCanonicalAssets({
      projectId: "project-1",
      client: db,
      assetClient: {
        uploadFile: vi.fn(),
        readFile: vi.fn().mockRejectedValue(new Error("Object is missing")),
      },
    });

    expect(result).toMatchObject({
      scanned: 1,
      skipped: 1,
      inconsistent: 1,
    });
    expect(await storedDocuments()).toEqual(new Map());
  });

  test("isolates an unreadable asset and removes its stale metadata", async () => {
    const updatedAt = "2026-07-18T07:00:00.000Z";
    await seedProject({
      assets: ["broken", "healthy"].map((id) => ({
        id,
        file: { name: `${id}.md`, size: 4, updatedAt },
      })),
    });
    await seedMetadata([
      createCanonicalAssetFileEntry({
        projectId: "project-1",
        document: {
          _id: "broken",
          _type: "asset.file",
          name: "broken.md",
          path: "broken.md",
          key: "broken",
          extension: "md",
          mimeType: "text/markdown",
          size: 3,
          revision: "file:broken.md:previous:3",
          contentRef: "broken.md",
          properties: { title: "Previous" },
        },
      }),
    ]);
    const readFile = vi.fn<AssetObjectStore["readFile"]>(async (name) => {
      if (name === "broken.md") {
        throw new Error("Object is missing");
      }
      return {
        data: {
          async *[Symbol.asyncIterator]() {
            yield encoder.encode("post");
          },
        },
      };
    });

    const result = await synchronizeCanonicalAssets({
      projectId: "project-1",
      client: db,
      assetClient: { uploadFile: vi.fn(), readFile },
    });

    expect(result).toMatchObject({ scanned: 2, indexed: 1 });
    expect(result.issues).toEqual([
      expect.objectContaining({
        assetId: "broken",
        storageName: "broken.md",
        message: "Object is missing",
      }),
    ]);
    expect([...(await storedDocuments()).keys()]).toEqual(["healthy"]);
  });
});
