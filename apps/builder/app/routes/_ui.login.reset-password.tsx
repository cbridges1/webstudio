// selfhost: the page a password reset email links to (?token=…).
import {
  json,
  type ActionFunctionArgs,
  type LinksFunction,
  type LoaderFunctionArgs,
} from "@remix-run/server-runtime";
import { useActionData, useLoaderData } from "@remix-run/react";
import { lazy } from "react";
import loginStyles from "~/auth/login.css?url";
import { ClientOnly } from "~/shared/client-only";
import { isDashboard } from "~/shared/router-utils";
import { allowedDestinations } from "~/services/destinations.server";
import { preventCrossOriginCookie } from "~/services/no-cross-origin-cookie";
import { createPrivateNoStoreHeaders } from "~/services/cache-control.server";
import {
  minPasswordLength,
  resetPassword,
} from "~/services/better-auth.server";
import {
  getBetterAuth,
  TOO_MANY_ATTEMPTS,
} from "~/services/username-auth.server";
export { ErrorBoundary } from "~/shared/error/error-boundary";

export const links: LinksFunction = () => [
  { rel: "stylesheet", href: loginStyles },
];

const assertDashboard = (request: Request) => {
  if (isDashboard(request) === false) {
    throw new Response("Not Found", { status: 404 });
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  assertDashboard(request);
  preventCrossOriginCookie(request);
  allowedDestinations(request, ["document", "empty"]);
  const token = new URL(request.url).searchParams.get("token") ?? undefined;
  // Keeps the token out of the Referer of anything this page loads.
  const headers = createPrivateNoStoreHeaders();
  headers.set("Referrer-Policy", "no-referrer");
  return json({ token, minPasswordLength }, { headers });
};

type Result = { done: boolean; errorMessage?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  assertDashboard(request);
  preventCrossOriginCookie(request);
  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("repeat") ?? "")) {
    return json<Result>({
      done: false,
      errorMessage: "The passwords don't match",
    });
  }
  const result = await resetPassword(getBetterAuth(), {
    token,
    password,
    request,
  });
  switch (result.status) {
    case "ok":
      return json<Result>({ done: true });
    case "rate-limited":
      return json<Result>({ done: false, errorMessage: TOO_MANY_ATTEMPTS });
    case "invalid-password":
      return json<Result>({ done: false, errorMessage: result.message });
    case "invalid-token":
      return json<Result>({
        done: false,
        errorMessage:
          "This link has expired or was already used. Ask for a new one.",
      });
  }
};

const ResetPassword = lazy(async () => {
  const { ResetPassword } = await import("~/auth/index.client");
  return { default: ResetPassword };
});

export default function ResetPasswordRoute() {
  const { token, minPasswordLength } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <ClientOnly>
      <ResetPassword
        token={token}
        minPasswordLength={minPasswordLength}
        done={result?.done}
        errorMessage={result?.errorMessage}
      />
    </ClientOnly>
  );
}
