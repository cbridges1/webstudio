// selfhost: the deploy service (apps/deploy). It takes jobs from this builder's database, so
// there's nothing to connect: this shows whether it's running, and app admins set an optional
// wake URL (called whenever a job is queued, to start a stopped service) and the builder's
// address as the service reaches it. When the builder's environment sets those
// (DEPLOYER_WAKE_URL, DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL), this only shows them.
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

type Settings = {
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

const Workers = ({ workers }: { workers: Settings["workers"] }) => {
  if (workers.length === 0) {
    return (
      <Text>
        No deploy service has connected to this builder's database yet. Start
        one (apps/deploy) with this database's DATABASE_URL.
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

const SettingsForm = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) => {
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
        <Grid gap="1">
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
        <Grid gap="1">
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
            Where the deploy service downloads builds and reports back, when it
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

export const DeployerDialog = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
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
    if (isOpen) {
      void load();
    } else {
      setWakeCheck(undefined);
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
              The deploy service takes publishes from this builder's database,
              so it needs no address or key here. Each project picks a host in
              Project settings → Deploy.
            </Text>
            {settings !== undefined && <Workers workers={settings.workers} />}
            {settings?.source === "env" && (
              <Text>
                Set by the builder's environment (DEPLOYER_WAKE_URL,
                DEPLOYER_WAKE_TOKEN, DEPLOYER_BUILDER_URL). Change them there.
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
          </Grid>
        </ScrollAreaNative>
        <DialogActions>
          <Button
            color="neutral"
            disabled={settings?.wakeUrl === null || settings === undefined}
            onClick={() => void testWake()}
          >
            Test wake URL
          </Button>
          <Button color="ghost" onClick={() => void load()}>
            Refresh
          </Button>
          <DialogClose>
            <Button color="ghost">Close</Button>
          </DialogClose>
        </DialogActions>
        <DialogTitle>Deployer</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};
