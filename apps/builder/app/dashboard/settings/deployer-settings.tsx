// selfhost: Settings → Deployer. App admins choose where publishes run (the deployer mode:
// builtin-deployer.server.ts): built into the builder (the default), or a separate deploy
// service (apps/deploy). Either takes jobs from this builder's database, so there's nothing to
// connect: this shows whether one is running, and for a separate service app admins set an
// optional wake URL (called whenever a job is queued, to start a stopped service). Both reach
// the builder at its own address unless a builder address is set. When the builder's
// environment sets those (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL), this
// only shows them; the mode saved here overrides DEPLOYER_MODE.
import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  CheckboxAndLabel,
  Flex,
  Grid,
  Label,
  Radio,
  RadioGroup,
  Text,
  cssVar,
  theme,
} from "@webstudio-is/design-system";
import { nativeClient } from "~/shared/trpc/trpc-client";
import {
  Badge,
  Field,
  Notice,
  SectionHeader,
  SettingsCard,
  StatusDot,
} from "./layout";

type Mode = "separate" | "builtin";

type Settings = {
  mode: Mode;
  modeSource: "app" | "env" | "default";
  envMode: Mode | null;
  source: "env" | "app";
  wakeUrl: string | null;
  wakeTokenEnding: string | null;
  builderUrl: string | null;
  workers: { id: string; seenAt: string; running: boolean; hosts: string[] }[];
};

type Message = { tone: "success" | "error"; text: string };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

const sinceText = (iso: string) => {
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  );
  if (seconds < 90) {
    return `${seconds} s ago`;
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return `${minutes} min ago`;
  }
  return new Date(iso).toLocaleString();
};

type ModeChoice = Mode | "env";

const modeLabels: Record<Mode, string> = {
  builtin: "Built into the builder",
  separate: "Separate deploy service",
};

const ModeOption = ({
  value,
  title,
  description,
  checked,
  badge,
}: {
  value: ModeChoice;
  title: string;
  description: string;
  checked: boolean;
  badge?: string;
}) => (
  <Box
    as="label"
    htmlFor={`deployer-mode-${value}`}
    css={{
      display: "flex",
      gap: theme.spacing[7],
      alignItems: "flex-start",
      padding: theme.spacing[9],
      borderRadius: theme.borderRadius[4],
      cursor: "pointer",
      border: `1px solid ${checked ? cssVar("--border-focus") : cssVar("--border-default")}`,
      background: checked ? cssVar("--background-secondary") : "transparent",
      "&:hover": { background: cssVar("--background-secondary") },
    }}
  >
    <Radio id={`deployer-mode-${value}`} value={value} />
    <Grid gap="2">
      <Flex align="center" gap="2">
        <Text variant="labels">{title}</Text>
        {badge && <Badge>{badge}</Badge>}
      </Flex>
      <Text color="subtle" css={{ lineHeight: 1.6 }}>
        {description}
      </Text>
    </Grid>
  </Box>
);

const ModeCard = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (message: Message) => void;
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const choice: ModeChoice =
    settings.modeSource === "app" ? settings.mode : "env";
  const envMode = settings.envMode ?? "builtin";
  const choose = async (next: ModeChoice) => {
    setIsSaving(true);
    const result = await nativeClient.deployer.setMode
      .mutate({ mode: next === "env" ? null : next })
      .catch(toError);
    setIsSaving(false);
    onSaved(
      result.success
        ? { tone: "success", text: "Saved where publishes run." }
        : { tone: "error", text: result.error }
    );
  };
  return (
    <SettingsCard
      title="Where publishes run"
      description="The deployer builds each published site and uploads it to the project's host. It takes publishes from this builder's database, so there's nothing to connect."
      actions={isSaving ? <Text color="subtle">Saving…</Text> : undefined}
    >
      <RadioGroup
        value={choice}
        disabled={isSaving}
        onValueChange={(next) => void choose(next as ModeChoice)}
        aria-label="Where publishes run"
      >
        <Grid gap="2">
          <ModeOption
            value="builtin"
            title={modeLabels.builtin}
            badge="Default"
            checked={choice === "builtin"}
            description="The builder builds and deploys sites itself, so nothing else needs to run. Builds use the builder's CPU and memory (on Cloud Run, give it always-allocated CPU), and project code runs next to the builder and its secrets: use it when you trust everyone who can publish."
          />
          <ModeOption
            value="separate"
            title={modeLabels.separate}
            checked={choice === "separate"}
            description="A deploy service (apps/deploy) runs on its own, with its own database login and none of the builder's secrets."
          />
          <ModeOption
            value="env"
            title="As the builder's environment says"
            badge={`DEPLOYER_MODE: ${settings.envMode ?? "not set"}`}
            checked={choice === "env"}
            description={`Follows DEPLOYER_MODE, so the deployment decides: currently ${modeLabels[envMode].toLowerCase()}.`}
          />
        </Grid>
      </RadioGroup>
    </SettingsCard>
  );
};

const StatusCard = ({
  settings,
  onRefresh,
}: {
  settings: Settings;
  onRefresh: () => void;
}) => {
  const { workers, mode } = settings;
  const running = workers.some((worker) => worker.running);
  return (
    <SettingsCard
      title="Status"
      description={
        running
          ? "A deployer is taking publishes."
          : "No deployer is running, so publishes wait in the queue."
      }
      actions={
        <Button color="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      }
      flush
    >
      {workers.length === 0 ? (
        <Box css={{ padding: `${theme.spacing[9]} ${theme.spacing[10]}` }}>
          <Text color="subtle" css={{ lineHeight: 1.6 }}>
            {mode === "builtin"
              ? "The built-in deployer hasn't started. The builder's log says why."
              : "No deploy service has connected to this builder's database yet. Start one (apps/deploy) with this database's DATABASE_URL."}
          </Text>
        </Box>
      ) : (
        workers.map((worker) => (
          <Flex
            key={worker.id}
            align="center"
            gap="3"
            css={{
              padding: `${theme.spacing[7]} ${theme.spacing[10]}`,
              borderTop: `1px solid ${cssVar("--border-default")}`,
              "&:first-child": { borderTop: "none" },
            }}
          >
            <StatusDot on={worker.running} />
            <Grid gap="1" css={{ flexGrow: 1, minWidth: 0 }}>
              <Text variant="mono" truncate>
                {worker.id}
              </Text>
              <Text color="subtle">
                {worker.running ? "Running" : "Not running"} · seen{" "}
                {sinceText(worker.seenAt)}
              </Text>
            </Grid>
            <Flex gap="2" css={{ flexWrap: "wrap", justifyContent: "end" }}>
              {worker.hosts.map((host) => (
                <Badge key={host}>{host}</Badge>
              ))}
            </Flex>
          </Flex>
        ))
      )}
    </SettingsCard>
  );
};

const ConnectionCard = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (message: Message) => void;
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [removeToken, setRemoveToken] = useState(false);
  const readOnly = settings.source === "env";
  const isSeparate = settings.mode === "separate";

  const testWake = async () => {
    setIsTesting(true);
    const result = await nativeClient.deployer.check.mutate().catch(toError);
    setIsTesting(false);
    if (result.success === false) {
      onSaved({ tone: "error", text: result.error });
      return;
    }
    const { wake } = result.data;
    onSaved(
      wake === null
        ? { tone: "error", text: "No wake URL is set." }
        : wake.ok
          ? { tone: "success", text: `The wake URL answered ${wake.status}.` }
          : {
              tone: "error",
              text: wake.error ?? `The wake URL answered ${wake.status}.`,
            }
    );
  };

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const field = (name: string) => String(form.get(name) ?? "").trim();
        setIsSaving(true);
        const result = await nativeClient.deployer.save
          .mutate({
            wakeUrl: field("wakeUrl"),
            wakeToken: field("wakeToken"),
            removeWakeToken: removeToken,
            builderUrl: field("builderUrl"),
          })
          .catch(toError);
        setIsSaving(false);
        onSaved(
          result.success
            ? { tone: "success", text: "Saved the connection settings." }
            : { tone: "error", text: result.error }
        );
      }}
    >
      <SettingsCard
        title="Connection"
        description={
          isSeparate
            ? "Optional. A wake URL starts a deploy service that stops while idle; a running one picks up publishes without it."
            : "Optional. Only needed when the deployer reaches this builder at another address."
        }
        footer={
          readOnly ? undefined : (
            <>
              {isSeparate && (
                <Button
                  type="button"
                  color="neutral"
                  disabled={settings.wakeUrl === null}
                  state={isTesting ? "pending" : undefined}
                  onClick={() => void testWake()}
                >
                  Test wake URL
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
              Set by the builder's environment (DEPLOYER_WAKE_URL,
              DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL). Change them there.
            </Notice>
          )}
          {/* Hidden rather than removed: a save keeps the separate service's values. */}
          <Grid gap="5" css={isSeparate ? undefined : { display: "none" }}>
            <Field
              id="deployer-wake-url"
              name="wakeUrl"
              label="Wake URL"
              placeholder="https://deploy.example.com/wake"
              defaultValue={settings.wakeUrl ?? ""}
              disabled={readOnly}
              hint="Called (POST) whenever a publish or another job is queued. The deploy service's own /wake works."
            />
            <Grid gap="3">
              <Field
                id="deployer-wake-token"
                name="wakeToken"
                label="Wake token"
                type="password"
                autoComplete="off"
                disabled={readOnly || removeToken}
                placeholder={
                  settings.wakeTokenEnding === null
                    ? "Sent as Authorization: Bearer <token>"
                    : `Unchanged (ends in ${settings.wakeTokenEnding})`
                }
              />
              {readOnly === false && settings.wakeTokenEnding !== null && (
                <CheckboxAndLabel>
                  <Checkbox
                    id="deployer-remove-token"
                    checked={removeToken}
                    onCheckedChange={(checked) =>
                      setRemoveToken(checked === true)
                    }
                  />
                  <Label htmlFor="deployer-remove-token">
                    Remove the token
                  </Label>
                </CheckboxAndLabel>
              )}
            </Grid>
          </Grid>
          <Field
            id="deployer-builder-url"
            name="builderUrl"
            label="Builder address"
            placeholder="This builder's own address"
            defaultValue={settings.builderUrl ?? ""}
            disabled={readOnly}
            hint="Where the deployer downloads builds and reports back, when it reaches this builder at another address (for example inside a private network)."
          />
        </Grid>
      </SettingsCard>
    </form>
  );
};

export const DeployerSettings = () => {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<Message>();

  const load = useCallback(async () => {
    setError(undefined);
    const result = await nativeClient.deployer.settings.query().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setSettings(result.data);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = (next: Message) => {
    setMessage(next);
    void load();
  };

  return (
    <Grid gap="5">
      <SectionHeader
        title="Deployer"
        description="Choose where published sites are built, and check that it's running. Each project picks its host in Project settings → Deploy."
      />
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {settings !== undefined && (
        <>
          <ModeCard settings={settings} onSaved={saved} />
          <StatusCard settings={settings} onRefresh={() => void load()} />
          <ConnectionCard
            // A fresh form with the saved values after each save.
            key={JSON.stringify(settings)}
            settings={settings}
            onSaved={saved}
          />
        </>
      )}
    </Grid>
  );
};
