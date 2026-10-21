// selfhost: username/password sign-in, modeled on auth.dev.tsx
import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { authenticator } from "~/services/auth.server";
import { dashboardPath, isDashboard, loginPath } from "~/shared/router-utils";
import { AUTH_PROVIDERS } from "~/shared/session";
import { clearReturnToCookie, returnToPath } from "~/services/cookie.server";
import { preventCrossOriginCookie } from "~/services/no-cross-origin-cookie";
import { redirect, setNoStoreToRedirect } from "~/services/no-store-redirect";
import {
  INVALID_CREDENTIALS,
  TOO_MANY_ATTEMPTS,
} from "~/services/username-auth.server";

export default function Password() {
  return null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  preventCrossOriginCookie(request);

  if (false === isDashboard(request)) {
    throw new Response("Not Found", {
      status: 404,
    });
  }

  const returnTo = (await returnToPath(request)) ?? dashboardPath();

  try {
    await authenticator.authenticate("password", request, {
      successRedirect: returnTo,
      throwOnError: true,
    });
  } catch (error: unknown) {
    // all redirects are basically errors and in that case we don't want to catch it
    if (error instanceof Response) {
      const response = await clearReturnToCookie(request, error);
      return setNoStoreToRedirect(response);
    }

    if (error instanceof Error) {
      if (error.message === TOO_MANY_ATTEMPTS) {
        return redirect(
          loginPath({
            error: AUTH_PROVIDERS.LOGIN_PASSWORD,
            message: TOO_MANY_ATTEMPTS,
            returnTo,
          })
        );
      }
      if (error.message !== INVALID_CREDENTIALS) {
        console.error("Error authenticating with password", error);
      }
      // Never show the raw error; the login page shows "Invalid username or password".
      return redirect(
        loginPath({ error: AUTH_PROVIDERS.LOGIN_PASSWORD, returnTo })
      );
    }
  }
};
