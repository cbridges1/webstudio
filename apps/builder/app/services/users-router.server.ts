// selfhost: app admins' account management (users-admin.server.ts).
import {
  createErrorResponse,
  procedure,
  router,
} from "@webstudio-is/trpc-interface/index.server";
import {
  addUser,
  addUserInput,
  listUsers,
  updateUser,
  updateUserInput,
} from "./users-admin.server";

const respond = async <T>(run: () => Promise<T>) => {
  try {
    return { success: true as const, data: await run() };
  } catch (error) {
    return createErrorResponse(error);
  }
};

export const usersRouter = router({
  list: procedure.query(({ ctx }) => respond(() => listUsers(ctx))),

  add: procedure
    .input(addUserInput)
    .mutation(({ input, ctx }) => respond(() => addUser(input, ctx))),

  update: procedure
    .input(updateUserInput)
    .mutation(({ input, ctx }) => respond(() => updateUser(input, ctx))),
});
