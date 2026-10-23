import { createHash, createVerify, generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createFirebaseAdapter } from "./firebase";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const credentials = {
  client_email: "deployer@my-project.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  token_uri: "https://oauth2.googleapis.com/token",
};

type Call = { method: string; url: string; body: unknown; auth: string | null };

/** A minimal fake of the token endpoint and the Hosting REST API. */
const createFakeGoogle = (alreadyUploaded: Set<string>) => {
  const calls: Call[] = [];
  const uploads = new Map<string, Buffer>();
  const fetchImpl: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const auth = new Headers(init.headers).get("Authorization");

    if (url === credentials.token_uri) {
      const params = new URLSearchParams(String(init.body));
      const [header, claims, signature] = params.get("assertion")!.split(".");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${claims}`);
      if (
        verifier.verify(publicKey, Buffer.from(signature, "base64url")) ===
        false
      ) {
        return new Response(
          JSON.stringify({ error_description: "bad signature" }),
          {
            status: 400,
          }
        );
      }
      calls.push({
        method,
        url,
        body: JSON.parse(Buffer.from(claims, "base64url").toString()),
        auth,
      });
      return Response.json({ access_token: "access-token" });
    }

    if (url.startsWith("https://upload.example/")) {
      const body = Buffer.from(init.body as Uint8Array);
      uploads.set(url.split("/").at(-1)!, body);
      calls.push({ method, url, body: undefined, auth });
      return new Response(null, { status: 200 });
    }

    const body =
      init.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ method, url, body, auth });
    if (url.endsWith("/versions") && method === "POST") {
      return Response.json({ name: "sites/my-site/versions/v1" });
    }
    if (url.endsWith(":populateFiles")) {
      const hashes = Object.values(
        (body as { files: Record<string, string> }).files
      );
      return Response.json({
        uploadRequiredHashes: hashes.filter(
          (hash) => alreadyUploaded.has(hash) === false
        ),
        uploadUrl: "https://upload.example/v1",
      });
    }
    return Response.json({});
  };
  return { fetchImpl, calls, uploads };
};

let buildDir: string;
beforeEach(async () => {
  buildDir = await mkdtemp(join(tmpdir(), "firebase-test-"));
  await mkdir(join(buildDir, "about"), { recursive: true });
  await writeFile(join(buildDir, "index.html"), "<h1>Home</h1>");
  await writeFile(join(buildDir, "about", "index.html"), "<h1>About</h1>");
});
afterEach(async () => {
  await rm(buildDir, { recursive: true, force: true });
});

const log = () => {};

describe("firebase adapter", () => {
  test("uploads only missing files, then finalizes and releases", async () => {
    const homeHash = (google: ReturnType<typeof createFakeGoogle>) => [
      ...google.uploads.keys(),
    ];
    const seen = new Set<string>();
    const google = createFakeGoogle(seen);
    const adapter = createFirebaseAdapter(google.fetchImpl);

    const { url } = await adapter.deploy({
      buildDir,
      config: { site: "my-site" },
      credentials,
      log,
    });

    expect(url).toBe("https://my-site.web.app");
    const api = google.calls.filter((call) =>
      call.url.includes("firebasehosting")
    );
    expect(
      api.map((call) => `${call.method} ${call.url.split("/v1beta1")[1]}`)
    ).toEqual([
      "POST /sites/my-site/versions",
      "POST /sites/my-site/versions/v1:populateFiles",
      "PATCH /sites/my-site/versions/v1?updateMask=status",
      "POST /sites/my-site/releases?versionName=sites%2Fmy-site%2Fversions%2Fv1",
    ]);
    expect(api.every((call) => call.auth === "Bearer access-token")).toBe(true);
    expect(api[2].body).toEqual({ status: "FINALIZED" });

    const files = (api[1].body as { files: Record<string, string> }).files;
    expect(Object.keys(files).sort()).toEqual([
      "/about/index.html",
      "/index.html",
    ]);
    // Uploaded content is the gzipped file, addressed by the SHA-256 of the gzip.
    for (const [hash, gzipped] of google.uploads) {
      expect(createHash("sha256").update(gzipped).digest("hex")).toBe(hash);
    }
    expect(
      homeHash(google)
        .map((hash) => gunzipSync(google.uploads.get(hash)!).toString())
        .sort()
    ).toEqual(["<h1>About</h1>", "<h1>Home</h1>"]);

    // The token request asked for the Hosting scope as this service account.
    const token = google.calls.find(
      (call) => call.url === credentials.token_uri
    )!;
    expect(token.body).toMatchObject({
      iss: credentials.client_email,
      scope: expect.stringContaining("firebase.hosting"),
    });
  });

  test("skips uploads Firebase already has", async () => {
    const first = createFakeGoogle(new Set());
    await createFirebaseAdapter(first.fetchImpl).deploy({
      buildDir,
      config: { site: "s" },
      credentials,
      log,
    });
    const second = createFakeGoogle(new Set(first.uploads.keys()));
    await createFirebaseAdapter(second.fetchImpl).deploy({
      buildDir,
      config: { site: "s", url: "https://www.example.com" },
      credentials,
      log,
    });
    expect(second.uploads.size).toBe(0);
  });

  test("uses a custom URL and hosting config when given", async () => {
    const google = createFakeGoogle(new Set());
    const { url } = await createFirebaseAdapter(google.fetchImpl).deploy({
      buildDir,
      config: {
        site: "s",
        url: "https://www.example.com",
        hostingConfig: { cleanUrls: true },
      },
      credentials,
      log,
    });
    expect(url).toBe("https://www.example.com");
    expect(
      google.calls.find((call) => call.url.endsWith("/versions"))?.body
    ).toEqual({
      config: { cleanUrls: true },
    });
  });

  test("remove disables the site", async () => {
    const google = createFakeGoogle(new Set());
    await createFirebaseAdapter(google.fetchImpl).remove({
      config: { site: "my-site" },
      credentials,
      log,
    });
    const release = google.calls.find((call) =>
      call.url.endsWith("/releases")
    )!;
    expect(release.body).toEqual({ type: "SITE_DISABLE" });
  });

  test("surfaces API errors", async () => {
    const google = createFakeGoogle(new Set());
    const failing: typeof fetch = async (input, init) =>
      String(input).endsWith("/versions")
        ? new Response('{"error":{"message":"Site not found"}}', {
            status: 404,
          })
        : google.fetchImpl(input, init);
    await expect(
      createFirebaseAdapter(failing).deploy({
        buildDir,
        config: { site: "missing" },
        credentials,
        log,
      })
    ).rejects.toThrow(/404.*Site not found/);
  });
});
