// selfhost: Settings → Deployer. App admins choose where publishes run (the deployer mode:
// builtin-deployer.server.ts): built into the builder, or a separate deploy service
// (apps/deploy). Either takes jobs from this builder's database, so there's nothing to connect:
// this shows whether one is running, and for a separate service app admins set an optional
// wake URL (called whenever a job is queued, to start a stopped service). Both reach the
// builder at its own address unless a builder address is set. When the builder's environment
// sets those (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL), this only shows
// them; the mode saved here overrides DEPLOYER_MODE.
import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  CheckboxAndLabel,
  Flex,
  Grid,
  InputField,
  Label,
  Select,
  Text,
} from "@webstudio-is/design-system";
import { nativeClient } from "~/shared/trpc/trpc-client";

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

type WakeCheck =
  | { state: "checking" }
  | { state: "done"; ok: boolean; message: string };

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

const Workers = ({
  workers,
  mode,
}: {
  workers: Settings["workers"];
  mode: Mode;
}) => {
  if (workers.length === 0) {
    return (
      <Text>
        {mode === "builtin"
          ? "The built-in deployer hasn't started. The builder's log says why."
          : "No deploy service has connected to this builder's database yet. Start one (apps/deploy) with this database's DATABASE_URL."}
      </Text>
    );
  }
  return (
    <Grid gap="1">
      {workers.map((worker) => (
        <Text key={worker.id} color={worker.running ? undefined : "subtle"}>
          {worker.id}: {worker.running ? "running" : "not running"} (seen{" "}
          {sinceText(worker.seenAt)}) · {worker.hosts.join(", ")}
        </Text>
      ))}
    </Grid>
  );
};

const modeLabels: Record<Mode, string> = {
  separate: "Separate deploy service",
  builtin: "Built into the builder",
};

type ModeChoice = Mode | "env";

const ModeForm = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) => {
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const choice: ModeChoice =
    settings.modeSource === "app" ? settings.mode : "env";
  const envLabel = `As the environment says (DEPLOYER_MODE: ${
    settings.envMode === null
      ? "not set, so separate"
      : modeLabels[settings.envMode].toLowerCase()
  })`;
  const choose = async (next: ModeChoice) => {
    setError(undefined);
    setIsSaving(true);
    const result = await nativeClient.deployer.setMode
      .mutate({ mode: next === "env" ? null : next })
      .catch(toError);
    setIsSaving(false);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    onSaved();
  };
  return (
    <Grid gap="1">
      <Label htmlFor="deployer-mode">Where publishes run</Label>
      <Select<ModeChoice>
        id="deployer-mode"
        options={["env", "separate", "builtin"]}
        value={choice}
        disabled={isSaving}
        getLabel={(option: ModeChoice) =>
          option === "env" ? envLabel : modeLabels[option]
        }
        onChange={(next) => void choose(next)}
      />
      <Text color="subtle">
        {settings.mode === "builtin"
          ? "The builder builds and deploys sites itself, so nothing else needs to run. Builds use the builder's CPU and memory; on a platform that throttles CPU between requests (Cloud Run's default) give it always-allocated CPU. Builds run project code next to the builder and its secrets, so use this only when you trust everyone who can publish."
          : "A deploy service (apps/deploy) runs on its own and takes publishes from this builder's database."}
      </Text>
      {error && <Text color="destructive">{error}</Text>}
    </Grid>
  );
};

const SettingsForm = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) => {
  const isSeparate = settings.mode === "separate";
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const [removeToken, setRemoveToken] = useState(false);
  const readOnly = settings.source === "env";

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const field = (name: string) => String(form.get(name) ?? "").trim();
        setError(undefined);
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
        if (result.success === false) {
          setError(result.error);
          return;
        }
        onSaved();
      }}
    >
      <Grid gap="3">
        <Grid gap="1" css={isSeparate ? undefined : { display: "none" }}>
          <Label htmlFor="deployer-wake-url">Wake URL (optional)</Label>
          <InputField
            id="deployer-wake-url"
            name="wakeUrl"
            placeholder="https://deploy.example.com/wake"
            defaultValue={settings.wakeUrl ?? ""}
            disabled={readOnly}
          />
          <Text color="subtle">
            Called (POST) whenever a publish or another job is queued, to start
            a deploy service that's stopped while idle. The deploy service's own
            /wake works. A running service picks up jobs without it.
          </Text>
        </Grid>
        <Grid gap="1" css={isSeparate ? undefined : { display: "none" }}>
          <Label htmlFor="deployer-wake-token">Wake token (optional)</Label>
          <InputField
            id="deployer-wake-token"
            name="wakeToken"
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
                onCheckedChange={(checked) => setRemoveToken(checked === true)}
              />
              <Label htmlFor="deployer-remove-token">Remove the token</Label>
            </CheckboxAndLabel>
          )}
        </Grid>
        <Grid gap="1">
          <Label htmlFor="deployer-builder-url">
            Builder address (optional)
          </Label>
          <InputField
            id="deployer-builder-url"
            name="builderUrl"
            placeholder="This builder's address"
            defaultValue={settings.builderUrl ?? ""}
            disabled={readOnly}
          />
          <Text color="subtle">
            Where the deployer downloads builds and reports back, when it
            reaches this builder at another address (for example inside a
            private network).
          </Text>
        </Grid>
        {error && <Text color="destructive">{error}</Text>}
        {readOnly === false && (
          <Flex justify="end">
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

export const DeployerSettings = () => {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [wakeCheck, setWakeCheck] = useState<WakeCheck>();

  const load = useCallback(async () => {
    setError(undefined);
    const result = await nativeClient.deployer.settings.query().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setSettings(result.data);
  }, []);

  const testWake = async () => {
    setWakeCheck({ state: "checking" });
    const result = await nativeClient.deployer.check.mutate().catch(toError);
    if (result.success === false) {
      setWakeCheck({ state: "done", ok: false, message: result.error });
      return;
    }
    const { wake } = result.data;
    setWakeCheck(
      wake === null
        ? { state: "done", ok: false, message: "No wake URL is set." }
        : {
            state: "done",
            ok: wake.ok,
            message: wake.ok
              ? `The wake URL answered ${wake.status}.`
              : (wake.error ?? `The wake URL answered ${wake.status}.`),
          }
    );
    await load();
  };

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Grid gap="3">
      <Text color="subtle">
        The deployer takes publishes from this builder's database, so it needs
        no address or key here. Each project picks a host in Project settings →
        Deploy.
      </Text>
      {settings !== undefined && (
        <ModeForm settings={settings} onSaved={() => void load()} />
      )}
      {settings !== undefined && (
        <Workers workers={settings.workers} mode={settings.mode} />
      )}
      {settings?.source === "env" && (
        <Text>
          The wake URL and builder address are set by the builder's environment
          (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL). Change
          them there.
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
      {wakeCheck?.state === "checking" && (
        <Text color="subtle">Calling the wake URL…</Text>
      )}
      {wakeCheck?.state === "done" && (
        <Text color={wakeCheck.ok ? undefined : "destructive"}>
          {wakeCheck.message}
        </Text>
      )}
      {error && <Text color="destructive">{error}</Text>}
      <Flex gap="2" justify="end">
        {settings?.mode === "separate" && (
          <Button
            color="neutral"
            disabled={settings.wakeUrl === null}
            onClick={() => void testWake()}
          >
            Test wake URL
          </Button>
        )}
        <Button color="ghost" onClick={() => void load()}>
          Refresh
        </Button>
      </Flex>
    </Grid>
  );
};
