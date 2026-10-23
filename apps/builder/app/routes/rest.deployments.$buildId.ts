// selfhost: where a deployer reports a publish (POST, `Authorization: <publish token>`,
// body: @webstudio-is/deploy-protocol's deployReport). See deployers.server.ts.
import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { createDbContext } from "~/shared/context.server";
import {
  DeployReportError,
  recordDeployReport,
} from "~/services/deployers.server";
import { privateNoStoreResponseHeaders } from "~/services/cache-control.server";

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const respond = (status: number, body: unknown) =>
    json(body, { status, headers: privateNoStoreResponseHeaders });

  if (request.method !== "POST") {
    return respond(405, { error: "Method not allowed" });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(400, { error: "Body isn't JSON" });
  }
  try {
    await recordDeployReport(
      {
        buildId: params.buildId ?? "",
        token: request.headers.get("Authorization"),
        body,
      },
      createDbContext()
    );
    return respond(200, { ok: true });
  } catch (error) {
    if (error instanceof DeployReportError) {
      return respond(error.status, { error: error.message });
    }
    throw error;
  }
};
