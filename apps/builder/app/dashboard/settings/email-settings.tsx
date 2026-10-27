// selfhost: Settings → Email: the SMTP server the builder sends email with (workspace
// invites, password resets). App admins set it here, unless the builder's environment sets
// SMTP_HOST, which this then only shows.
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  CheckboxAndLabel,
  Flex,
  Grid,
  InputField,
  Label,
  Text,
} from "@webstudio-is/design-system";
import { nativeClient } from "~/shared/trpc/trpc-client";
import {
  Badge,
  Field,
  FieldGrid,
  Notice,
  SectionHeader,
  SettingsCard,
} from "./layout";

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

type Message = { tone: "success" | "error"; text: string };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

const statusBadge = (settings: Settings) =>
  settings.source === "none" ? (
    <Badge>Off</Badge>
  ) : settings.source === "env" ? (
    <Badge tone="positive">On · from the environment</Badge>
  ) : (
    <Badge tone="positive">On</Badge>
  );

const ServerCard = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (message: Message) => void;
}) => {
  const saved = settings.source === "none" ? undefined : settings;
  const readOnly = settings.source === "env";
  const [secure, setSecure] = useState(saved?.secure ?? false);
  const [isSaving, setIsSaving] = useState(false);

  const remove = async () => {
    const result = await nativeClient.email.remove.mutate().catch(toError);
    onSaved(
      result.success
        ? { tone: "success", text: "Email is off." }
        : { tone: "error", text: result.error }
    );
  };

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const field = (name: string) => String(form.get(name) ?? "").trim();
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
        onSaved(
          result.success
            ? { tone: "success", text: "Saved. Send a test email to check it." }
            : { tone: "error", text: result.error }
        );
      }}
    >
      <SettingsCard
        title="SMTP server"
        description="Any SMTP provider works: SES, Resend, SendGrid, Postmark, Gmail with an app password, …"
        actions={statusBadge(settings)}
        footer={
          readOnly ? undefined : (
            <>
              {saved !== undefined && (
                <Button
                  type="button"
                  color="ghost"
                  onClick={() => void remove()}
                >
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
            </>
          )
        }
      >
        <Grid gap="5">
          {readOnly && (
            <Notice>
              Set by the builder's environment (SMTP_HOST, SMTP_PORT,
              SMTP_SECURE, SMTP_USER, SMTP_PASSWORD, SMTP_FROM). Change it
              there.
            </Notice>
          )}
          <FieldGrid>
            <Field
              id="smtp-host"
              name="host"
              label="Server"
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
          </FieldGrid>
          <Field
            id="smtp-from"
            name="from"
            label="From"
            placeholder="Webstudio <noreply@example.com>"
            defaultValue={saved?.from}
            disabled={readOnly}
            hint="The sender people see. Most providers only allow addresses you've verified."
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
        </Grid>
      </SettingsCard>
    </form>
  );
};

const TestCard = ({ defaultTo }: { defaultTo?: string }) => {
  const [to, setTo] = useState(defaultTo ?? "");
  const [result, setResult] = useState<Message>();
  const [isSending, setIsSending] = useState(false);
  return (
    <SettingsCard
      title="Send a test email"
      description="Checks the server, the login and the sender in one go."
    >
      <Grid gap="3">
        <Flex gap="2" align="end">
          <Grid gap="2" css={{ flexGrow: 1 }}>
            <Label htmlFor="smtp-test-to">To</Label>
            <InputField
              id="smtp-test-to"
              type="email"
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </Grid>
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
                  ? { tone: "error", text: response.error }
                  : response.data.sent
                    ? { tone: "success", text: `Sent to ${to}.` }
                    : { tone: "error", text: response.data.error }
              );
            }}
          >
            Send
          </Button>
        </Flex>
        {result && <Notice tone={result.tone}>{result.text}</Notice>}
      </Grid>
    </SettingsCard>
  );
};

export const EmailSettings = ({
  userEmail,
}: {
  /** Prefills the test address. */
  userEmail?: string;
}) => {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<Message>();

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
    void load();
  }, [load]);

  return (
    <Grid gap="5">
      <SectionHeader
        title="Email"
        description="The builder emails workspace invites and password reset links. Without email, invites only show in the dashboard and admins reset passwords."
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {settings !== undefined && (
        <>
          <ServerCard
            // A fresh form with the saved values after each save.
            key={JSON.stringify(settings)}
            settings={settings}
            onSaved={(next) => {
              setMessage(next);
              void load();
            }}
          />
          {settings.source !== "none" && <TestCard defaultTo={userEmail} />}
        </>
      )}
      {settings === undefined && error === undefined && (
        <Text color="subtle">Loading…</Text>
      )}
    </Grid>
  );
};
