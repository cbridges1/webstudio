// selfhost: Settings → Users. App admins add accounts (there is no public sign-up: a name
// and the email they sign in with), rename them, change their email or password, disable them
// and give or take the admin role (users-admin.server.ts). A new user either gets a password
// from the admin or an invite: a link to choose their own, emailed when email is set up and
// shown to the admin to share.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Avatar,
  Box,
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Flex,
  Grid,
  IconButton,
  Label,
  Text,
  cssVar,
  theme,
} from "@webstudio-is/design-system";
import { EllipsesIcon, PlusIcon } from "@webstudio-is/icons";
import { nativeClient } from "~/shared/trpc/trpc-client";
import {
  Badge,
  Field,
  FieldGrid,
  Notice,
  SectionHeader,
  SettingsCard,
} from "./layout";

type Account = {
  name: string;
  email: string;
  disabled: boolean;
  admin: boolean;
  invited: boolean;
  isSelf: boolean;
};

type Result =
  | { success: true; data: Account[] }
  | { success: false; error: string };

type InviteLink = {
  email: string;
  url: string;
  emailed: boolean;
  emailError?: string;
};

type AddResult =
  | { success: true; data: { users: Account[]; invite?: InviteLink } }
  | { success: false; error: string };

type InviteResult =
  | { success: true; data: InviteLink }
  | { success: false; error: string };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

const minPasswordLength = 12;

const initials = (account: Account) =>
  (account.name || account.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

/** A dialog holding one small form, with Save and Cancel. */
const FormDialog = ({
  title,
  submitLabel,
  onClose,
  onSubmit,
  error,
  isSaving,
  width = theme.spacing[33],
  children,
}: {
  title: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
  error?: string;
  isSaving: boolean;
  width?: string;
  children: ReactNode;
}) => (
  <Dialog open onOpenChange={(open) => open === false && onClose()}>
    <DialogContent css={{ width }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(new FormData(event.currentTarget));
        }}
      >
        <Grid
          gap="5"
          css={{ padding: `${theme.spacing[9]} ${theme.spacing[10]}` }}
        >
          {children}
          {error && <Notice tone="error">{error}</Notice>}
        </Grid>
        <DialogActions>
          <Button
            type="submit"
            color="primary"
            state={isSaving ? "pending" : undefined}
          >
            {submitLabel}
          </Button>
          <DialogClose>
            <Button type="button" color="ghost">
              Cancel
            </Button>
          </DialogClose>
        </DialogActions>
      </form>
      <DialogTitle>{title}</DialogTitle>
    </DialogContent>
  </Dialog>
);

const AddUserDialog = ({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (users: Account[], email: string, invite?: InviteLink) => void;
}) => {
  const [admin, setAdmin] = useState(false);
  const [invite, setInvite] = useState(true);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  return (
    <FormDialog
      title="Add a user"
      submitLabel="Add user"
      width={theme.spacing[35]}
      onClose={onClose}
      error={error}
      isSaving={isSaving}
      onSubmit={async (form) => {
        const field = (name: string) => String(form.get(name) ?? "");
        if (invite === false && field("password") !== field("confirm")) {
          setError("The passwords don't match");
          return;
        }
        setError(undefined);
        setIsSaving(true);
        const email = field("email").trim();
        const result: AddResult = await nativeClient.users.add
          .mutate({
            name: field("name").trim(),
            email,
            password: invite ? undefined : field("password"),
            admin,
          })
          .catch(toError);
        setIsSaving(false);
        if (result.success === false) {
          setError(result.error);
          return;
        }
        onAdded(result.data.users, email.toLowerCase(), result.data.invite);
      }}
    >
      <Text color="subtle" css={{ lineHeight: 1.6 }}>
        {invite
          ? "They get a link to choose their own password, by email when email is set up. You also get the link to share."
          : "They sign in with this email and password. Share the password with them; with email set up they can also reset it themselves."}
      </Text>
      <FieldGrid>
        <Field
          id="new-user-name"
          name="name"
          label="Name"
          autoComplete="off"
          required
          autoFocus
          hint="Shown in the builder"
        />
        <Field
          id="new-user-email"
          name="email"
          label="Email"
          type="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          hint="Also where invites and reset links go"
        />
        {invite === false && (
          <>
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
          </>
        )}
      </FieldGrid>
      <CheckboxAndLabel>
        <Checkbox
          id="new-user-invite"
          checked={invite}
          onCheckedChange={(checked) => setInvite(checked === true)}
        />
        <Label htmlFor="new-user-invite">
          Let them choose their own password
        </Label>
      </CheckboxAndLabel>
      <CheckboxAndLabel>
        <Checkbox
          id="new-user-admin"
          checked={admin}
          onCheckedChange={(checked) => setAdmin(checked === true)}
        />
        <Label htmlFor="new-user-admin">
          Admin: can manage users, the deployer and email
        </Label>
      </CheckboxAndLabel>
    </FormDialog>
  );
};

/** Shows an invite's set-password link, for the admin to share. */
const InviteLinkDialog = ({
  invite,
  onClose,
}: {
  invite: InviteLink;
  onClose: () => void;
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => open === false && onClose()}>
      <DialogContent css={{ width: theme.spacing[35] }}>
        <Grid
          gap="5"
          css={{ padding: `${theme.spacing[9]} ${theme.spacing[10]}` }}
        >
          {invite.emailed ? (
            <Notice tone="success">
              Emailed {invite.email} a link to choose their password.
            </Notice>
          ) : invite.emailError === "Email isn't set up" ? (
            <Notice>
              Email isn't set up, so send {invite.email} this link yourself.
            </Notice>
          ) : (
            <Notice tone="error">
              The invite wasn't emailed ({invite.emailError}). Send them this
              link yourself.
            </Notice>
          )}
          <Field
            id="invite-link"
            label="Set-password link"
            value={invite.url}
            readOnly
            onFocus={(event) => (event.target as HTMLInputElement).select()}
            hint="It works once, for 7 days. Anyone with it can set this account's password, so share it only with them."
          />
        </Grid>
        <DialogActions>
          <Button
            type="button"
            color="primary"
            onClick={() => {
              void navigator.clipboard
                .writeText(invite.url)
                .then(() => setCopied(true));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
          <DialogClose>
            <Button type="button" color="ghost">
              Done
            </Button>
          </DialogClose>
        </DialogActions>
        <DialogTitle>Invite {invite.email}</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};

type Edit = { kind: "password" | "name" | "email"; account: Account };

const editTitles: Record<Edit["kind"], string> = {
  password: "Change password",
  name: "Rename",
  email: "Change email",
};

const EditDialog = ({
  edit: { kind, account },
  onClose,
  onSaved,
}: {
  edit: Edit;
  onClose: () => void;
  onSaved: (users: Account[]) => void;
}) => {
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const input = (form: FormData) => {
    const field = (name: string) => String(form.get(name) ?? "");
    const email = account.email;
    if (kind === "password") {
      if (field("password") !== field("confirm")) {
        return "The passwords don't match";
      }
      return {
        action: "password" as const,
        email,
        password: field("password"),
      };
    }
    if (kind === "name") {
      return { action: "name" as const, email, name: field("name").trim() };
    }
    return {
      action: "email" as const,
      email,
      newEmail: field("newEmail").trim(),
    };
  };
  return (
    <FormDialog
      title={`${editTitles[kind]}: ${account.name || account.email}`}
      submitLabel="Save"
      onClose={onClose}
      error={error}
      isSaving={isSaving}
      onSubmit={async (form) => {
        const next = input(form);
        if (typeof next === "string") {
          setError(next);
          return;
        }
        setError(undefined);
        setIsSaving(true);
        const result: Result = await nativeClient.users.update
          .mutate(next)
          .catch(toError);
        setIsSaving(false);
        if (result.success === false) {
          setError(result.error);
          return;
        }
        onSaved(result.data);
      }}
    >
      {kind === "password" && (
        <>
          <Text color="subtle" css={{ lineHeight: 1.6 }}>
            {account.email} is signed out everywhere and signs in with the new
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
        </>
      )}
      {kind === "name" && (
        <Field
          id="user-name"
          name="name"
          label="Name"
          defaultValue={account.name}
          required
          autoFocus
          hint="Shown in the builder"
        />
      )}
      {kind === "email" && (
        <Field
          id="user-email"
          name="newEmail"
          label="New email"
          type="email"
          defaultValue={account.email}
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          hint="They sign in with it from now on"
        />
      )}
    </FormDialog>
  );
};

const columns = "minmax(0, 1fr) 160px 32px";

const UserRow = ({
  account,
  onChange,
  onError,
  onEdit,
  onInvite,
}: {
  account: Account;
  onChange: (users: Account[]) => void;
  onError: (error: string) => void;
  onEdit: (kind: Edit["kind"]) => void;
  onInvite: (invite: InviteLink) => void;
}) => {
  const resendInvite = async () => {
    const result: InviteResult = await nativeClient.users.resendInvite
      .mutate({ email: account.email })
      .catch(toError);
    if (result.success === false) {
      onError(result.error);
      return;
    }
    onInvite(result.data);
  };
  const run = async (
    action: "disable" | "enable" | "admin" | "unadmin"
  ): Promise<void> => {
    const result: Result = await nativeClient.users.update
      .mutate({ action, email: account.email })
      .catch(toError);
    if (result.success === false) {
      onError(result.error);
      return;
    }
    onChange(result.data);
  };
  return (
    <Box
      role="row"
      css={{
        display: "grid",
        gridTemplateColumns: columns,
        alignItems: "center",
        gap: theme.spacing[7],
        padding: `${theme.spacing[7]} ${theme.spacing[10]}`,
        borderTop: `1px solid ${cssVar("--border-default")}`,
        "&:hover": { background: cssVar("--overlay-interaction-hover") },
      }}
    >
      <Flex
        align="center"
        gap="3"
        role="cell"
        css={{ minWidth: 0, opacity: account.disabled ? 0.55 : 1 }}
      >
        <Avatar fallback={initials(account)} alt={account.name} />
        <Grid gap="1" css={{ minWidth: 0 }}>
          <Flex align="center" gap="2">
            <Text variant="labels" truncate>
              {account.name || account.email}
            </Text>
            {account.isSelf && <Badge>You</Badge>}
          </Flex>
          <Text color="subtle" truncate>
            {account.email}
          </Text>
        </Grid>
      </Flex>
      <Flex gap="2" role="cell" css={{ flexWrap: "wrap" }}>
        {account.admin ? (
          <Badge tone="accent">Admin</Badge>
        ) : (
          <Badge>Member</Badge>
        )}
        {account.invited && <Badge>Invited</Badge>}
        {account.disabled && <Badge tone="negative">Disabled</Badge>}
      </Flex>
      <Flex justify="end" role="cell">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton aria-label={`Actions for ${account.email}`}>
              <EllipsesIcon />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onEdit("name")}>
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onEdit("email")}>
              Change email…
            </DropdownMenuItem>
            {account.invited && (
              <DropdownMenuItem onSelect={() => void resendInvite()}>
                Resend invite…
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => onEdit("password")}>
              {account.invited ? "Set password…" : "Change password…"}
            </DropdownMenuItem>
            {account.isSelf === false && (
              <>
                <DropdownMenuSeparator />
                {account.admin ? (
                  <DropdownMenuItem onSelect={() => void run("unadmin")}>
                    Remove admin role
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onSelect={() => void run("admin")}>
                    Make admin
                  </DropdownMenuItem>
                )}
                {account.disabled ? (
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
                )}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </Flex>
    </Box>
  );
};

const ColumnTitle = ({ children }: { children?: ReactNode }) => (
  <Text
    variant="small"
    color="subtle"
    role="columnheader"
    css={{ textTransform: "uppercase", letterSpacing: "0.04em" }}
  >
    {children}
  </Text>
);

export const UsersSettings = () => {
  const [users, setUsers] = useState<Account[]>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [edit, setEdit] = useState<Edit>();
  const [isAdding, setIsAdding] = useState(false);
  const [invite, setInvite] = useState<InviteLink>();

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

  const admins = users?.filter((account) => account.admin).length ?? 0;

  return (
    <Grid gap="5">
      <SectionHeader
        title="Users"
        description="Everyone signs in with their email and password. There is no public sign-up: admins add or invite every account here. Invited users choose their own password from their link. Disabled users can't sign in; their projects stay."
        actions={
          <Button
            color="primary"
            prefix={<PlusIcon />}
            onClick={() => setIsAdding(true)}
          >
            Add user
          </Button>
        }
      />
      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <SettingsCard
        title={
          users === undefined
            ? "Accounts"
            : `${users.length} account${users.length === 1 ? "" : "s"}`
        }
        description={
          users === undefined
            ? "Loading…"
            : `${admins} admin${admins === 1 ? "" : "s"}. Admins see this page and can change any account.`
        }
        flush
      >
        <Box role="table" aria-label="Users">
          <Box
            role="row"
            css={{
              display: "grid",
              gridTemplateColumns: columns,
              gap: theme.spacing[7],
              padding: `${theme.spacing[5]} ${theme.spacing[10]}`,
              background: cssVar("--background-secondary"),
            }}
          >
            <ColumnTitle>User</ColumnTitle>
            <ColumnTitle>Role</ColumnTitle>
            <ColumnTitle />
          </Box>
          {users?.map((account) => (
            <UserRow
              key={account.email}
              account={account}
              onChange={(next) => update(next)}
              onError={setError}
              onEdit={(kind) => setEdit({ kind, account })}
              onInvite={(next) => {
                setError(undefined);
                setNotice(undefined);
                setInvite(next);
              }}
            />
          ))}
        </Box>
      </SettingsCard>
      {isAdding && (
        <AddUserDialog
          onClose={() => setIsAdding(false)}
          onAdded={(next, email, added) => {
            update(
              next,
              added
                ? `Invited ${email}. They can sign in once they choose a password.`
                : `Added ${email}. They can sign in now.`
            );
            setIsAdding(false);
            setInvite(added);
          }}
        />
      )}
      {invite !== undefined && (
        <InviteLinkDialog
          invite={invite}
          onClose={() => setInvite(undefined)}
        />
      )}
      {edit !== undefined && (
        <EditDialog
          edit={edit}
          onClose={() => setEdit(undefined)}
          onSaved={(next) => {
            update(next, `Saved ${edit.account.email}.`);
            setEdit(undefined);
          }}
        />
      )}
    </Grid>
  );
};
