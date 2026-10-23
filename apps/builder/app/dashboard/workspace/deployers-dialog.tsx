// selfhost: a workspace's deployers (deploy services its projects publish through).
// Owners and admins add each one with its URL and API key; projects then pick one in
// Project settings → Deploy.
import { useCallback, useEffect, useState } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogClose,
  DialogContent,
  DialogTitle,
  Flex,
  Grid,
  IconButton,
  InputField,
  Label,
  ScrollAreaNative,
  Text,
  Tooltip,
  css,
  cssVar,
  theme,
} from "@webstudio-is/design-system";
import { PlusIcon, TrashIcon } from "@webstudio-is/icons";
import type { Workspace } from "@webstudio-is/project";
import { nativeClient } from "~/shared/trpc/trpc-client";

type Deployer = {
  id: string;
  name: string;
  url: string;
  builderUrl: string | null;
  apiKeyEnding: string;
};

type Status =
  | { state: "checking" }
  | { state: "ok"; hosts: string[] }
  | {
      state: "error";
      error: string;
    };

const rowStyle = css({
  paddingInline: theme.spacing[5],
  paddingBlock: theme.spacing[3],
  borderRadius: theme.borderRadius[4],
  "&:hover, &:focus-within": {
    backgroundColor: cssVar("--overlay-interaction-hover"),
  },
});

const DeployerForm = ({
  workspaceId,
  deployer,
  onDone,
  onCancel,
}: {
  workspaceId: string;
  /** Undefined: adds a new deployer. */
  deployer?: Deployer;
  onDone: () => void;
  onCancel: () => void;
}) => {
  const [error, setError] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const field = (name: string) => String(form.get(name) ?? "").trim();
        const input = {
          name: field("name"),
          url: field("url"),
          builderUrl: field("builderUrl"),
          apiKey: field("apiKey"),
        };
        setError(undefined);
        setIsSaving(true);
        try {
          const result =
            deployer === undefined
              ? await nativeClient.deployers.create.mutate({
                  ...input,
                  workspaceId,
                })
              : await nativeClient.deployers.update.mutate({
                  ...input,
                  deployerId: deployer.id,
                });
          if (result.success === false) {
            setError(result.error);
            return;
          }
          onDone();
        } catch (error) {
          setError(error instanceof Error ? error.message : String(error));
        } finally {
          setIsSaving(false);
        }
      }}
    >
      <Grid gap="2" css={{ paddingInline: theme.spacing[5] }}>
        <Text variant="labels">
          {deployer === undefined ? "Add a deployer" : `Edit ${deployer.name}`}
        </Text>
        <Grid gap="1">
          <Label htmlFor="deployer-name">Name</Label>
          <InputField
            id="deployer-name"
            name="name"
            placeholder="Production"
            defaultValue={deployer?.name}
          />
        </Grid>
        <Grid gap="1">
          <Label htmlFor="deployer-url">URL</Label>
          <InputField
            id="deployer-url"
            name="url"
            placeholder="https://deploy.example.com"
            defaultValue={deployer?.url}
          />
        </Grid>
        <Grid gap="1">
          <Label htmlFor="deployer-key">API key</Label>
          <InputField
            id="deployer-key"
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder={
              deployer === undefined
                ? "The deployer's DEPLOY_API_KEY"
                : `Unchanged (ends in ${deployer.apiKeyEnding})`
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
            defaultValue={deployer?.builderUrl ?? ""}
          />
          <Text color="subtle">
            Where the deployer downloads builds and reports back, when it
            reaches this builder at another address (for example inside a
            private network).
          </Text>
        </Grid>
        {error && <Text color="destructive">{error}</Text>}
        <Flex gap="2" justify="end">
          <Button type="button" color="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="submit"
            color="primary"
            state={isSaving ? "pending" : undefined}
          >
            {deployer === undefined ? "Add" : "Save"}
          </Button>
        </Flex>
      </Grid>
    </form>
  );
};

export const DeployersDialog = ({
  workspace,
  isOpen,
  onOpenChange,
}: {
  workspace: Workspace;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  const [deployers, setDeployers] = useState<Deployer[]>();
  const [error, setError] = useState<string>();
  const [statuses, setStatuses] = useState<Record<string, Status>>({});
  // "new", a deployer ID being edited, or undefined.
  const [editing, setEditing] = useState<string>();

  const check = useCallback(async (deployerId: string) => {
    setStatuses((current) => ({
      ...current,
      [deployerId]: { state: "checking" },
    }));
    const result = await nativeClient.deployers.check
      .mutate({ deployerId })
      .catch((error: Error) => ({
        success: false as const,
        error: error.message,
      }));
    setStatuses((current) => ({
      ...current,
      [deployerId]: result.success
        ? { state: "ok", hosts: result.data.hosts.map((host) => host.label) }
        : { state: "error", error: result.error },
    }));
  }, []);

  const load = useCallback(async () => {
    setError(undefined);
    const result = await nativeClient.deployers.list
      .query({ workspaceId: workspace.id })
      .catch((error: Error) => ({
        success: false as const,
        error: error.message,
      }));
    if (result.success === false) {
      setError(result.error);
      return;
    }
    setDeployers(result.data);
    for (const deployer of result.data) {
      void check(deployer.id);
    }
  }, [workspace.id, check]);

  useEffect(() => {
    if (isOpen) {
      void load();
    } else {
      setEditing(undefined);
    }
  }, [isOpen, load]);

  const remove = async (deployer: Deployer) => {
    const result = await nativeClient.deployers.remove.mutate({
      deployerId: deployer.id,
    });
    if (result.success === false) {
      setError(result.error);
      return;
    }
    await load();
  };

  const editedDeployer = deployers?.find((deployer) => deployer.id === editing);

  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent css={{ width: theme.spacing[35] }}>
        <ScrollAreaNative css={{ maxHeight: "70vh" }}>
          <Grid gap="3" css={{ paddingBlock: theme.spacing[5] }}>
            <Text css={{ paddingInline: theme.spacing[5] }} color="subtle">
              Deploy services this workspace's projects can publish through.
              Each project picks one in Project settings → Deploy. Removing a
              deployer clears it from the projects that use it.
            </Text>
            {deployers?.length === 0 && editing === undefined && (
              <Text css={{ paddingInline: theme.spacing[5] }}>
                No deployers yet.
              </Text>
            )}
            <Box>
              {deployers?.map((deployer) => {
                const status = statuses[deployer.id];
                return (
                  <Flex
                    key={deployer.id}
                    align="center"
                    gap="2"
                    justify="between"
                    className={rowStyle()}
                  >
                    <Flex direction="column" css={{ minWidth: 0 }}>
                      <Text variant="labels" truncate>
                        {deployer.name}
                      </Text>
                      <Text color="subtle" truncate>
                        {deployer.url}
                      </Text>
                      {status?.state === "checking" && (
                        <Text color="subtle">Checking…</Text>
                      )}
                      {status?.state === "ok" && (
                        <Text color="subtle" truncate>
                          Connected · {status.hosts.join(", ")}
                        </Text>
                      )}
                      {status?.state === "error" && (
                        <Text color="destructive">{status.error}</Text>
                      )}
                    </Flex>
                    <Flex gap="1" css={{ flexShrink: 0 }}>
                      <Button
                        color="ghost"
                        onClick={() => void check(deployer.id)}
                      >
                        Check
                      </Button>
                      <Button
                        color="ghost"
                        onClick={() => setEditing(deployer.id)}
                      >
                        Edit
                      </Button>
                      <Tooltip content="Remove deployer">
                        <IconButton
                          aria-label="Remove deployer"
                          onClick={() => void remove(deployer)}
                        >
                          <TrashIcon />
                        </IconButton>
                      </Tooltip>
                    </Flex>
                  </Flex>
                );
              })}
            </Box>
            {editing !== undefined && (
              <DeployerForm
                key={editing}
                workspaceId={workspace.id}
                deployer={editedDeployer}
                onCancel={() => setEditing(undefined)}
                onDone={() => {
                  setEditing(undefined);
                  void load();
                }}
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
          <Button
            color="neutral"
            prefix={<PlusIcon />}
            disabled={editing !== undefined}
            onClick={() => setEditing("new")}
          >
            Add deployer
          </Button>
          <DialogClose>
            <Button color="ghost">Close</Button>
          </DialogClose>
        </DialogActions>
        <DialogTitle>Deployers</DialogTitle>
      </DialogContent>
    </Dialog>
  );
};
