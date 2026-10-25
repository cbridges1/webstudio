// selfhost: asks for a password reset link by email (see email.server.ts).
import {
  json,
  type ActionFunctionArgs,
  type LinksFunction,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useActionData, useLoaderData } from "@remix-run/react";
import { lazy } from "react";
import { getDb } from "@webstudio-is/db";
import env from "~/env/env.server";
import loginStyles from "~/auth/login.css?url";
import { ClientOnly } from "~/shared/client-only";
import { isDashboard } from "~/shared/router-utils";
import { allowedDestinations } from "~/services/destinations.server";
import { preventCrossOriginCookie } from "~/services/no-cross-origin-cookie";
import { createPrivateNoStoreHeaders } from "~/services/cache-control.server";
import { requestPasswordReset } from "~/services/better-auth.server";
import { isEmailEnabled } from "~/services/email.server";
import {
  getBetterAuth,
  TOO_MANY_ATTEMPTS,
} from "~/services/username-auth.server";
export { ErrorBoundary } from "~/shared/error/error-boundary";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: loginStyles },
];

const isEnabled = async () =>
  env.AUTH_USERNAME_LOGIN === "true" &&
  (await isEmailEnabled(getDb(env.DATABASE_URL)));

const assertDashboard = (request: Request) => {
  if (isDashboard(request) === false) {
    throw new Response("Not Found", { status: 404 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  assertDashboard(request);
  preventCrossOriginCookie(request);
  allowedDestinations(request, ["document", "empty"]);
  return json(
    { isEnabled: await isEnabled() },
    { headers: createPrivateNoStoreHeaders() }
  );
};

type Result = { sent: boolean; errorMessage?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  assertDashboard(request);
  preventCrossOriginCookie(request);
  if ((await isEnabled()) === false) {
    return json<Result>({ sent: false, errorMessage: "Email isn't set up" });
  }
  const form = await request.formData();
  const email = String(form.get("email") ?? "").trim();
  if (email === "" || email.includes("@") === false) {
    return json<Result>({ sent: false, errorMessage: "Enter your email" });
  }
  const result = await requestPasswordReset(getBetterAuth(), {
    email,
    request,
  });
  return result === "rate-limited"
    ? json<Result>({ sent: false, errorMessage: TOO_MANY_ATTEMPTS })
    : json<Result>({ sent: true });
};

const ForgotPassword = lazy(async () => {
  const { ForgotPassword } = await import("~/auth/index.client");
  return { default: ForgotPassword };
});

export default function ForgotPasswordRoute() {
  const { isEnabled } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <ClientOnly>
      <ForgotPassword
        isEnabled={isEnabled}
        sent={result?.sent}
        errorMessage={result?.errorMessage}
      />
    </ClientOnly>
  );
}
