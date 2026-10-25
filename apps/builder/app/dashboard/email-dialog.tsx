// selfhost: the SMTP server the builder sends email with (workspace invites, password
// resets). App admins set it here, unless the builder's environment sets SMTP_HOST, which this
// then only shows.
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
  Flex,
  Grid,
  InputField,
  Label,
  ScrollAreaNative,
  Text,
  theme,
} from "@webstudio-is/design-system";
import { nativeClient } from "~/shared/trpc/trpc-client";

type Settings =
  | { source: "none" }
  | {
      source: "env" | "app";
      host: string;
      port: number;
      secure: boolean;
      username: string | null;
      hasPassword: boolean;
      from: string;
    };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

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
  <Grid gap="1">
    <Label htmlFor={id}>{label}</Label>
    <InputField id={id} {...props} />
    {hint && <Text color="subtle">{hint}</Text>}
  </Grid>
);

const SettingsForm = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) => {
  const saved = settings.source === "none" ? undefined : settings;
  const readOnly = settings.source === "env";
  const [secure, setSecure] = useState(saved?.secure ?? false);
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  const remove = async () => {
    setError(undefined);
    const result = await nativeClient.email.remove.mutate().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    onSaved();
  };

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const field = (name: string) => String(form.get(name) ?? "").trim();
        setError(undefined);
        setIsSaving(true);
        const result = await nativeClient.email.save
          .mutate({
            host: field("host"),
            port: Number(field("port") || (secure ? 465 : 587)),
            secure,
            username: field("username"),
            password: String(form.get("password") ?? ""),
            from: field("from"),
          })
          .catch(toError);
        setIsSaving(false);
        if (result.success === false) {
          setError(result.error);
          return;
        }
        onSaved();
      }}
    >
      <Grid gap="3">
        <Field
          id="smtp-host"
          name="host"
          label="SMTP server"
          placeholder="smtp.example.com"
          defaultValue={saved?.host}
          disabled={readOnly}
        />
        <Field
          id="smtp-port"
          name="port"
          label="Port"
          inputMode="numeric"
          placeholder={secure ? "465" : "587"}
          defaultValue={saved?.port === undefined ? "" : String(saved.port)}
          disabled={readOnly}
        />
        <CheckboxAndLabel>
          <Checkbox
            id="smtp-secure"
            checked={secure}
            disabled={readOnly}
            onCheckedChange={(checked) => setSecure(checked === true)}
          />
          <Label htmlFor="smtp-secure">
            TLS from the start (usually port 465). Off: STARTTLS when offered.
          </Label>
        </CheckboxAndLabel>
        <Field
          id="smtp-username"
          name="username"
          label="Username (optional)"
          autoComplete="off"
          defaultValue={saved?.username ?? ""}
          disabled={readOnly}
        />
        <Field
          id="smtp-password"
          name="password"
          label="Password"
          type="password"
          autoComplete="new-password"
          disabled={readOnly}
          placeholder={saved?.hasPassword ? "Unchanged" : ""}
          hint="Stored encrypted; it can't be viewed again."
        />
        <Field
          id="smtp-from"
          name="from"
          label="From"
          placeholder="Webstudio <noreply@example.com>"
          defaultValue={saved?.from}
          disabled={readOnly}
        />
        {error && <Text color="destructive">{error}</Text>}
        {readOnly === false && (
          <Flex gap="2" justify="end">
            {saved !== undefined && (
              <Button type="button" color="ghost" onClick={() => void remove()}>
                Turn off email
              </Button>
            )}
            <Button
              type="submit"
              color="primary"
              state={isSaving ? "pending" : undefined}
            >
              Save
            </Button>
          </Flex>
        )}
      </Grid>
    </form>
  );
};

const TestEmail = ({ defaultTo }: { defaultTo?: string }) => {
  const [to, setTo] = useState(defaultTo ?? "");
  const [result, setResult] = useState<{ ok: boolean; message: string }>();
  const [isSending, setIsSending] = useState(false);
  return (
    <Grid gap="1">
      <Label htmlFor="smtp-test-to">Send a test email to</Label>
      <Flex gap="2">
        <InputField
          id="smtp-test-to"
          type="email"
          value={to}
          onChange={(event) => setTo(event.target.value)}
          css={{ flexGrow: 1 }}
        />
        <Button
          color="neutral"
          state={isSending ? "pending" : undefined}
          disabled={to.trim() === ""}
          onClick={async () => {
            setIsSending(true);
            const response = await nativeClient.email.test
              .mutate({ to })
              .catch(toError);
            setIsSending(false);
            setResult(
              response.success === false
                ? { ok: false, message: response.error }
                : response.data.sent
                  ? { ok: true, message: `Sent to ${to}.` }
                  : { ok: false, message: response.data.error }
            );
          }}
        >
          Send
        </Button>
      </Flex>
      {result && (
        <Text color={result.ok ? undefined : "destructive"}>
          {result.message}
        </Text>
      )}
    </Grid>
  );
};

export const EmailDialog = ({
  isOpen,
  onOpenChange,
  userEmail,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  /** Prefills the test address. */
  userEmail?: string;
}) => {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    setError(undefined);
    const result = await nativeClient.email.settings.query().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setSettings(result.data);
  }, []);

  useEffect(() => {
    if (isOpen) {
      void load();
    }
  }, [isOpen, load]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent css={{ width: theme.spacing[35] }}>
        <ScrollAreaNative css={{ maxHeight: "70vh" }}>
          <Grid
            gap="3"
            css={{
              paddingBlock: theme.spacing[5],
              paddingInline: theme.spacing[5],
            }}
          >
            <Text color="subtle">
              The SMTP server the builder sends workspace invites and password
              reset links with. Without one, invites only show in the dashboard
              and passwords are reset by an administrator.
            </Text>
            {settings?.source === "none" && <Text>Email is off.</Text>}
            {settings?.source === "env" && (
              <Text>
                Set by the builder's environment (SMTP_HOST, SMTP_PORT,
                SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM). Change it
                there.
              </Text>
            )}
            {settings !== undefined && (
              <SettingsForm
                // A fresh form with the saved values after each save.
                key={JSON.stringify(settings)}
                settings={settings}
                onSaved={() => void load()}
              />
            )}
            {settings !== undefined && settings.source !== "none" && (
              <TestEmail defaultTo={userEmail} />
            )}
            {error && <Text color="destructive">{error}</Text>}
          </Grid>
        </ScrollAreaNative>
        <DialogActions>
          <DialogClose>
            <Button color="ghost">Close</Button>
          </DialogClose>
        </DialogActions>
        <DialogTitle>Email</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};
