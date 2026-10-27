import { describe, expect, test } from "vitest";
import {
  createProjectPathsMiddleware,
  parseProjectPath,
  toProjectPathUrl,
} from "../../project-paths.mjs";

const id = "090e6e14-ae50-4b2e-bd22-71733cec05bb";
const other = "1b2c3d4e-ae50-4b2e-bd22-71733cec05bb";
const host = "builder.example.com";

type Headers = Record<string, string | undefined>;

const run = (url: string, headers: Headers = {}) => {
  const req = {
    url,
    originalUrl: url,
    headers: { host, ...headers } as Headers,
  };
  const written: Record<string, unknown> = {};
  const res = {
    setHeader: (name: string, value: unknown) => {
      written[name] = value;
    },
    writeHead: (_status: number, headers?: Record<string, unknown>) => {
      Object.assign(written, headers);
    },
  };
  let called = false;
  createProjectPathsMiddleware()(req, res, () => {
    called = true;
  });
  expect(called).toBe(true);
  return { req, res, written };
};

describe("parseProjectPath", () => {
  test("splits off the project", () => {
    expect(parseProjectPath(`/p/${id}/rest/x?y=1`)).toEqual({
      projectId: id,
      path: "/rest/x?y=1",
    });
    expect(parseProjectPath(`/p/${id}`)).toEqual({ projectId: id, path: "/" });
    expect(parseProjectPath(`/p/${id}?a=1`)).toEqual({
      projectId: id,
      path: "/?a=1",
    });
  });

  test("ignores other paths", () => {
    expect(parseProjectPath("/dashboard")).toBeUndefined();
    expect(parseProjectPath("/p/not-a-project/")).toBeUndefined();
    expect(parseProjectPath(`/p/${id}x/`)).toBeUndefined();
  });
});

describe("toProjectPathUrl", () => {
  test("maps a project origin to its path", () => {
    expect(
      toProjectPathUrl(`https://p-${id}.${host}/auth/ws/callback?code=1`, {
        host,
        relativeToProject: true,
      })
    ).toBe(`https://${host}/p/${id}/auth/ws/callback?code=1`);
  });

  test("prefixes relative URLs only for a project", () => {
    const options = { host, projectId: id };
    expect(
      toProjectPathUrl("/error", { ...options, relativeToProject: true })
    ).toBe(`/p/${id}/error`);
    expect(
      toProjectPathUrl("/error", { ...options, relativeToProject: false })
    ).toBe("/error");
  });

  test("leaves other hosts alone", () => {
    for (const value of [
      `https://${host}/login`,
      `https://p-${id}.elsewhere.com/`,
      "https://accounts.example.org/authorize",
    ]) {
      expect(toProjectPathUrl(value, { host, relativeToProject: true })).toBe(
        value
      );
    }
  });
});

describe("createProjectPathsMiddleware", () => {
  test("leaves dashboard requests alone", () => {
    const { req } = run("/dashboard", {
      origin: `https://${host}`,
      "sec-fetch-site": "same-origin",
    });
    expect(req.url).toBe("/dashboard");
    expect(req.headers.host).toBe(host);
    expect(req.headers.origin).toBe(`https://${host}`);
    expect(req.headers["sec-fetch-site"]).toBe("same-origin");
  });

  test("maps a project path onto the project's origin", () => {
    const { req } = run(`/p/${id}/trpc/x?batch=1`, {
      origin: `https://${host}`,
      referer: `https://${host}/p/${id}/?pageId=home`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "empty",
    });
    expect(req.url).toBe("/trpc/x?batch=1");
    expect(req.originalUrl).toBe("/trpc/x?batch=1");
    expect(req.headers.host).toBe(`p-${id}.${host}`);
    expect(req.headers.origin).toBe(`https://p-${id}.${host}`);
    expect(req.headers.referer).toBe(`https://p-${id}.${host}/?pageId=home`);
    expect(req.headers["sec-fetch-site"]).toBe("same-origin");
  });

  test("sends a project page's unprefixed requests to its project", () => {
    const { req } = run("/rest/resources-loader", {
      referer: `https://${host}/p/${id}/canvas`,
      "sec-fetch-dest": "empty",
      "sec-fetch-site": "same-origin",
    });
    expect(req.url).toBe("/rest/resources-loader");
    expect(req.headers.host).toBe(`p-${id}.${host}`);
    expect(req.headers.referer).toBe(`https://p-${id}.${host}/canvas`);
  });

  test("lets a project page navigate to the dashboard", () => {
    const { req } = run("/dashboard", {
      referer: `https://${host}/p/${id}/`,
      "sec-fetch-dest": "document",
      "sec-fetch-site": "same-origin",
    });
    expect(req.headers.host).toBe(host);
    expect(req.headers["sec-fetch-site"]).toBe("same-site");
  });

  test("treats the dashboard calling a project as same-site", () => {
    const { req } = run(`/p/${id}/builder-logout`, {
      origin: `https://${host}`,
      referer: `https://${host}/logout`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "empty",
    });
    expect(req.headers.host).toBe(`p-${id}.${host}`);
    expect(req.headers.origin).toBe(`https://${host}`);
    expect(req.headers["sec-fetch-site"]).toBe("same-site");
  });

  test("treats one project calling another as same-site", () => {
    const { req } = run(`/p/${other}/rest/x`, {
      origin: `https://${host}`,
      referer: `https://${host}/p/${id}/`,
      "sec-fetch-site": "same-origin",
      "sec-fetch-dest": "empty",
    });
    expect(req.headers.host).toBe(`p-${other}.${host}`);
    expect(req.headers.origin).toBe(`https://p-${id}.${host}`);
    expect(req.headers["sec-fetch-site"]).toBe("same-site");
  });

  test("maps redirects back to paths", () => {
    const { res, written } = run(`/p/${id}/auth/ws`, {
      "sec-fetch-dest": "document",
    });
    res.setHeader("Location", `https://p-${id}.${host}/?pageId=home`);
    expect(written.Location).toBe(`https://${host}/p/${id}/?pageId=home`);
    res.setHeader("Location", "/error");
    expect(written.Location).toBe(`/p/${id}/error`);
    res.setHeader("X-Remix-Redirect", "/error");
    expect(written["X-Remix-Redirect"]).toBe("/error");
    res.writeHead(302, { location: `https://${host}/login` });
    expect(written.location).toBe(`https://${host}/login`);
  });

  test("maps the dashboard's redirects to a project origin", () => {
    // oauth/ws/authorize sends the browser back to the project's callback.
    const { res, written } = run("/oauth/ws/authorize", {
      referer: `https://${host}/p/${id}/`,
      "sec-fetch-dest": "document",
    });
    res.setHeader(
      "Location",
      `https://p-${id}.${host}/auth/ws/callback?code=1`
    );
    expect(written.Location).toBe(
      `https://${host}/p/${id}/auth/ws/callback?code=1`
    );
  });
});
