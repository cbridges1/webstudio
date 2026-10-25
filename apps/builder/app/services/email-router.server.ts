// selfhost: app admins' email settings (email.server.ts).
import { z } from "zod";
import {
  createErrorResponse,
  procedure,
  router,
} from "@webstudio-is/trpc-interface/index.server";
import {
  emailSettingsInput,
  loadEmailAdminSettings,
  removeEmailSettings,
  saveEmailSettings,
  sendTestEmail,
} from "./email.server";

const respond = async <T>(run: () => Promise<T>) => {
  try {
    return { success: true as const, data: await run() };
  } catch (error) {
    return createErrorResponse(error);
  }
};

export const emailRouter = router({
  settings: procedure.query(({ ctx }) =>
    respond(() => loadEmailAdminSettings(ctx))
  ),

  save: procedure
    .input(emailSettingsInput)
    .mutation(({ input, ctx }) => respond(() => saveEmailSettings(input, ctx))),

  remove: procedure.mutation(({ ctx }) =>
    respond(() => removeEmailSettings(ctx))
  ),

  test: procedure
    .input(z.object({ to: z.string().trim().email() }))
    .mutation(({ input, ctx }) => respond(() => sendTestEmail(input, ctx))),
});
