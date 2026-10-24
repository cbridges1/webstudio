// selfhost: the deployer (the deploy service every project publishes through). App admins
// set its URL and API key here, unless the builder's environment sets it (DEPLOYER_URL),
// which this then only shows. Projects pick a host on it in Project settings → Deploy.
import { useCallback, useEffect, useState } from "react";
import {
  Button,
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
      url: string;
      builderUrl: string | null;
      apiKeyEnding: string;
    };

type Status =
  | { state: "checking" }
  | { state: "ok"; hosts: string[] }
  | { state: "error"; error: string };

const toError = (error: Error) => ({
  success: false as const,
  error: error.message,
});

const DeployerForm = ({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) => {
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const saved = settings.source === "none" ? undefined : settings;
  const readOnly = settings.source === "env";

  const remove = async () => {
    setError(undefined);
    const result = await nativeClient.deployer.remove.mutate().catch(toError);
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
        const result = await nativeClient.deployer.save
          .mutate({
            url: field("url"),
            apiKey: field("apiKey"),
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
      <Grid gap="3" css={{ paddingInline: theme.spacing[5] }}>
        <Grid gap="1">
          <Label htmlFor="deployer-url">URL</Label>
          <InputField
            id="deployer-url"
            name="url"
            placeholder="https://deploy.example.com"
            defaultValue={saved?.url}
            disabled={readOnly}
          />
        </Grid>
        <Grid gap="1">
          <Label htmlFor="deployer-key">API key</Label>
          <InputField
            id="deployer-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            disabled={readOnly}
            placeholder={
              saved === undefined
                ? "The deployer's DEPLOY_API_KEY"
                : `Unchanged (ends in ${saved.apiKeyEnding})`
            }
          />
        </Grid>
        <Grid gap="1">
          <Label htmlFor="deployer-builder-url">
            Builder address (optional)
          </Label>
          <InputField
            id="deployer-builder-url"
            name="builderUrl"
            placeholder="This builder's address"
            defaultValue={saved?.builderUrl ?? ""}
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
          <Flex gap="2" justify="end">
            {saved !== undefined && (
              <Button type="button" color="ghost" onClick={() => void remove()}>
                Remove
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

export const DeployerDialog = ({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<Status>();

  const check = useCallback(async () => {
    setStatus({ state: "checking" });
    const result = await nativeClient.deployer.check.mutate().catch(toError);
    setStatus(
      result.success
        ? { state: "ok", hosts: result.data.hosts.map((host) => host.label) }
        : { state: "error", error: result.error }
    );
  }, []);

  const load = useCallback(async () => {
    setError(undefined);
    setStatus(undefined);
    const result = await nativeClient.deployer.settings.query().catch(toError);
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setSettings(result.data);
    if (result.data.source !== "none") {
      void check();
    }
  }, [check]);

  useEffect(() => {
    if (isOpen) {
      void load();
    }
  }, [isOpen, load]);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent css={{ width: theme.spacing[35] }}>
        <ScrollAreaNative css={{ maxHeight: "70vh" }}>
          <Grid gap="3" css={{ paddingBlock: theme.spacing[5] }}>
            <Text css={{ paddingInline: theme.spacing[5] }} color="subtle">
              The deploy service every project publishes through. Each project
              picks a host on it in Project settings → Deploy.
            </Text>
            {settings?.source === "env" && (
              <Text css={{ paddingInline: theme.spacing[5] }}>
                Set by the builder's environment (DEPLOYER_URL,
                DEPLOYER_API_KEY, DEPLOYER_BUILDER_URL). Change it there.
              </Text>
            )}
            {settings?.source === "none" && (
              <Text css={{ paddingInline: theme.spacing[5] }}>
                No deployer yet. Publish stays off until one is set.
              </Text>
            )}
            {status !== undefined && (
              <Flex
                gap="2"
                align="center"
                justify="between"
                css={{ paddingInline: theme.spacing[5] }}
              >
                {status.state === "checking" && (
                  <Text color="subtle">Checking…</Text>
                )}
                {status.state === "ok" && (
                  <Text color="subtle" truncate>
                    Connected · {status.hosts.join(", ")}
                  </Text>
                )}
                {status.state === "error" && (
                  <Text color="destructive">{status.error}</Text>
                )}
                <Button color="ghost" onClick={() => void check()}>
                  Check
                </Button>
              </Flex>
            )}
            {settings !== undefined && (
              <DeployerForm
                // A fresh form with the saved values after each save.
                key={JSON.stringify(settings)}
                settings={settings}
                onSaved={() => void load()}
              />
            )}
            {error && (
              <Text
                color="destructive"
                css={{ paddingInline: theme.spacing[5] }}
              >
                {error}
              </Text>
            )}
          </Grid>
        </ScrollAreaNative>
        <DialogActions>
          <DialogClose>
            <Button color="ghost">Close</Button>
          </DialogClose>
        </DialogActions>
        <DialogTitle>Deployer</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};
