import {
  and,
  eq,
  maybeOne,
  one,
  user as userTable,
  workspace,
  type Database,
} from "@webstudio-is/db";
import { createId } from "@webstudio-is/sdk";
import {
  AuthorizationError,
  type AppContext,
} from "@webstudio-is/trpc-interface/index.server";
import type { GitHubProfile } from "remix-auth-github";
import type { GoogleProfile } from "remix-auth-google";
import { z } from "zod";

// The Webstudio user. The row also holds Better Auth's columns (sign-in name,
// ban state); those stay on the server.
const userColumns = {
  id: userTable.id,
  createdAt: userTable.createdAt,
  email: userTable.email,
  image: userTable.image,
  provider: userTable.provider,
  username: userTable.username,
  projectsTags: userTable.projectsTags,
};

type UserRow = Pick<
  Database["public"]["Tables"]["User"]["Row"],
  keyof typeof userColumns
>;

export type User = Omit<UserRow, "projectsTags"> & {
  projectsTags: Array<ProjectTag>;
};

const formatUser = (user: UserRow) => {
  return {
    ...user,
    projectsTags: (user.projectsTags || []) as User["projectsTags"],
  };
};

export const getUserById = async (context: AppContext, id: User["id"]) => {
  const rows = await context.db
    .select(userColumns)
    .from(userTable)
    .where(eq(userTable.id, id));

  if (rows.length !== 1) {
    console.error(`User ${id} not found`);
    throw new Error("User not found");
  }

  return formatUser(rows[0]);
};

const genericCreateAccount = async (
  context: AppContext,
  userData: {
    email: string;
    username: string;
    image: string;
    provider: string;
  },
  syncProfile = false
): Promise<User> => {
  const existingUser = maybeOne(
    await context.db
      .select(userColumns)
      .from(userTable)
      .where(eq(userTable.email, userData.email))
  );

  if (existingUser !== null) {
    let user = existingUser;

    if (
      syncProfile &&
      (user.username !== userData.username ||
        user.image !== userData.image ||
        user.provider !== userData.provider)
    ) {
      try {
        user = one(
          await context.db
            .update(userTable)
            .set({
              username: userData.username,
              image: userData.image,
              provider: userData.provider,
            })
            .where(eq(userTable.id, user.id))
            .returning(userColumns)
        );
      } catch (error) {
        console.error(error);
        throw new Error("Failed to update user profile");
      }
    }

    // Ensure the user has a default workspace — it may be missing if
    // the original workspace insert failed after user creation.
    const existingWorkspace = maybeOne(
      await context.db
        .select({ id: workspace.id })
        .from(workspace)
        .where(
          and(
            eq(workspace.userId, existingUser.id),
            eq(workspace.isDefault, true)
          )
        )
    );

    if (existingWorkspace === null) {
      await context.db
        .insert(workspace)
        .values({
          name: "My workspace",
          isDefault: true,
          userId: existingUser.id,
        })
        .catch((error) => {
          console.error("Failed to lazily create default workspace", error);
        });
    }

    return formatUser(user);
  }

  const userId = createId();

  let newUser: UserRow;
  try {
    newUser = one(
      await context.db
        .insert(userTable)
        .values({ id: userId, ...userData })
        .returning(userColumns)
    );
  } catch (error) {
    console.error(error);
    throw new Error("Failed to create user");
  }

  // Every user gets a default workspace that cannot be deleted.
  try {
    await context.db.insert(workspace).values({
      name: "My workspace",
      isDefault: true,
      userId,
    });
  } catch (error) {
    console.error(error);
    throw new Error("Failed to create default workspace");
  }

  return formatUser(newUser);
};

export const createOrLoginWithOAuth = async (
  context: AppContext,
  profile: GoogleProfile | GitHubProfile
): Promise<User> => {
  const userData = {
    email: (profile.emails ?? [])[0]?.value,
    username: profile.displayName,
    image: (profile.photos ?? [])[0]?.value,
    provider: profile.provider,
  };
  const newUser = await genericCreateAccount(context, userData, true);
  return newUser;
};

export const userProjectTag = z.object({
  id: z.string(),
  label: z.string().min(1).max(100),
});

export type ProjectTag = z.infer<typeof userProjectTag>;

export const updateUserProjectsTags = async (
  { tags }: { tags: ProjectTag[] },
  context: AppContext
) => {
  if (context.authorization.type !== "user") {
    throw new AuthorizationError(
      "Only logged in users can update project tags"
    );
  }
  const updated = one(
    await context.db
      .update(userTable)
      .set({ projectsTags: tags })
      .where(eq(userTable.id, context.authorization.userId))
      .returning({ projectsTags: userTable.projectsTags }),
    "User"
  );
  return updated.projectsTags as ProjectTag[];
};
