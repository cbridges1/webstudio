// selfhost: Settings → Users. App admins add accounts (there is no public sign-up), change
// passwords, disable accounts and give or take the admin role (users-admin.server.ts).
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  CheckboxAndLabel,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Flex,
  Grid,
  IconButton,
  InputField,
  Label,
  Text,
  cssVar,
  theme,
} from "@webstudio-is/design-system";
import { EllipsesIcon } from "@webstudio-is/icons";
import { nativeClient } from "~/shared/trpc/trpc-client";

type Account = {
  username: string;
  email: string | null;
  disabled: boolean;
  admin: boolean;
  isSelf: boolean;
};

type Result =
  | { success: true; data: Account[] }
  | { success: false; error: string };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

const minPasswordLength = 12;

const Field = ({
  id,
  label,
  hint,
  ...props
}: {
  id: string;
  label: string;
  hint?: string;
} & React.ComponentProps<typeof InputField>) => (
  // Fields side by side keep their inputs level when only one has a hint.
  <Grid gap="1" css={{ alignContent: "start" }}>
    <Label htmlFor={id}>{label}</Label>
    <InputField id={id} {...props} />
    {hint && <Text color="subtle">{hint}</Text>}
  </Grid>
);

const AddUserForm = ({ onAdded }: { onAdded: (users: Account[]) => void }) => {
  const [admin, setAdmin] = useState(false);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const formElement = event.currentTarget;
        const form = new FormData(formElement);
        const field = (name: string) => String(form.get(name) ?? "");
        if (field("password") !== field("confirm")) {
          setError("The passwords don't match");
          return;
        }
        setError(undefined);
        setIsSaving(true);
        const result: Result = await nativeClient.users.add
          .mutate({
            username: field("username").trim(),
            email: field("email").trim(),
            password: field("password"),
            admin,
          })
          .catch(toError);
        setIsSaving(false);
        if (result.success === false) {
          setError(result.error);
          return;
        }
        formElement.reset();
        setAdmin(false);
        onAdded(result.data);
      }}
    >
      <Grid gap="3">
        <Text variant="titles">Add a user</Text>
        <Grid gap="3" css={{ gridTemplateColumns: "1fr 1fr" }}>
          <Field
            id="new-user-username"
            name="username"
            label="Username"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
            hint="3–32 letters, digits, '.', '_' or '-'"
          />
          <Field
            id="new-user-email"
            name="email"
            label="Email (optional)"
            type="email"
            autoComplete="off"
            hint="Needed for password reset links and workspace invites"
          />
          <Field
            id="new-user-password"
            name="password"
            label="Password"
            type="password"
            autoComplete="new-password"
            required
            minLength={minPasswordLength}
            hint={`At least ${minPasswordLength} characters`}
          />
          <Field
            id="new-user-confirm"
            name="confirm"
            label="Repeat the password"
            type="password"
            autoComplete="new-password"
            required
          />
        </Grid>
        <CheckboxAndLabel>
          <Checkbox
            id="new-user-admin"
            checked={admin}
            onCheckedChange={(checked) => setAdmin(checked === true)}
          />
          <Label htmlFor="new-user-admin">
            Admin (manages users, the deployer and email)
          </Label>
        </CheckboxAndLabel>
        {error && <Text color="destructive">{error}</Text>}
        <Flex justify="end">
          <Button
            type="submit"
            color="primary"
            state={isSaving ? "pending" : undefined}
          >
            Add user
          </Button>
        </Flex>
      </Grid>
    </form>
  );
};

const PasswordDialog = ({
  username,
  onClose,
  onSaved,
}: {
  username: string;
  onClose: () => void;
  onSaved: (users: Account[]) => void;
}) => {
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => open === false && onClose()}>
      <DialogContent css={{ width: theme.spacing[33] }}>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const password = String(form.get("password") ?? "");
            if (password !== String(form.get("confirm") ?? "")) {
              setError("The passwords don't match");
              return;
            }
            setError(undefined);
            setIsSaving(true);
            const result: Result = await nativeClient.users.update
              .mutate({ action: "password", username, password })
              .catch(toError);
            setIsSaving(false);
            if (result.success === false) {
              setError(result.error);
              return;
            }
            onSaved(result.data);
          }}
        >
          <Grid gap="3" css={{ padding: theme.spacing[5] }}>
            <Text color="subtle">
              {username} is signed out everywhere and signs in with the new
              password.
            </Text>
            <Field
              id="user-password"
              name="password"
              label="New password"
              type="password"
              autoComplete="new-password"
              required
              autoFocus
              minLength={minPasswordLength}
              hint={`At least ${minPasswordLength} characters`}
            />
            <Field
              id="user-password-confirm"
              name="confirm"
              label="Repeat the password"
              type="password"
              autoComplete="new-password"
              required
            />
            {error && <Text color="destructive">{error}</Text>}
          </Grid>
          <DialogActions>
            <Button
              type="submit"
              color="primary"
              state={isSaving ? "pending" : undefined}
            >
              Change password
            </Button>
            <DialogClose>
              <Button type="button" color="ghost">
                Cancel
              </Button>
            </DialogClose>
          </DialogActions>
        </form>
        <DialogTitle>Change {username}'s password</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};

const UserRow = ({
  account,
  onChange,
  onError,
  onChangePassword,
}: {
  account: Account;
  onChange: (users: Account[]) => void;
  onError: (error: string) => void;
  onChangePassword: () => void;
}) => {
  const run = async (
    action: "disable" | "enable" | "admin" | "unadmin"
  ): Promise<void> => {
    const result: Result = await nativeClient.users.update
      .mutate({ action, username: account.username })
      .catch(toError);
    if (result.success === false) {
      onError(result.error);
      return;
    }
    onChange(result.data);
  };
  const notes = [
    account.isSelf ? "you" : undefined,
    account.admin ? "admin" : undefined,
    account.disabled ? "disabled" : undefined,
  ].filter(Boolean);
  return (
    <Flex
      align="center"
      gap="3"
      css={{
        paddingBlock: theme.spacing[5],
        borderBottom: `1px solid ${cssVar("--border-default")}`,
      }}
    >
      <Grid gap="1" css={{ flexGrow: 1, minWidth: 0 }}>
        <Text
          variant="labels"
          color={account.disabled ? "subtle" : "main"}
          truncate
        >
          {account.username}
          {notes.length > 0 && ` (${notes.join(", ")})`}
        </Text>
        <Text color="subtle" truncate>
          {account.email ?? "No email"}
        </Text>
      </Grid>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label={`Actions for ${account.username}`}>
            <EllipsesIcon />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onChangePassword}>
            Change password…
          </DropdownMenuItem>
          {account.isSelf === false &&
            (account.admin ? (
              <DropdownMenuItem onSelect={() => void run("unadmin")}>
                Remove admin role
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onSelect={() => void run("admin")}>
                Make admin
              </DropdownMenuItem>
            ))}
          {account.isSelf === false &&
            (account.disabled ? (
              <DropdownMenuItem onSelect={() => void run("enable")}>
                Enable
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                destructive
                onSelect={() => void run("disable")}
              >
                Disable (signs them out)
              </DropdownMenuItem>
            ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </Flex>
  );
};

export const UsersSettings = () => {
  const [users, setUsers] = useState<Account[]>();
  const [error, setError] = useState<string>();
  const [passwordFor, setPasswordFor] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    const result: Result = await nativeClient.users.list.query().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setUsers(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const update = (next: Account[], message?: string) => {
    setError(undefined);
    setNotice(message);
    setUsers(next);
  };

  return (
    <Grid gap="5">
      <Text color="subtle">
        There is no public sign-up: admins add every account. Users sign in with
        their username or email. Disabled users can't sign in; their projects
        stay.
      </Text>
      {notice && <Text>{notice}</Text>}
      {error && <Text color="destructive">{error}</Text>}
      {users !== undefined && (
        <Grid>
          {users.map((account) => (
            <UserRow
              key={account.username}
              account={account}
              onChange={(next) => update(next)}
              onError={setError}
              onChangePassword={() => setPasswordFor(account.username)}
            />
          ))}
        </Grid>
      )}
      <AddUserForm onAdded={(next) => update(next, "User added.")} />
      {passwordFor !== undefined && (
        <PasswordDialog
          username={passwordFor}
          onClose={() => setPasswordFor(undefined)}
          onSaved={(next) => {
            update(next, `Changed ${passwordFor}'s password.`);
            setPasswordFor(undefined);
          }}
        />
      )}
    </Grid>
  );
};
