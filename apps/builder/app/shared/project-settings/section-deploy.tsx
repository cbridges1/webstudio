// selfhost: where Publish sends this project: one of its workspace's deployers and a
// target there. The deployer describes its hosts (settings and credentials as JSON Schema),
// so this form works for any host it offers. Credentials are write-only: the builder keeps
// them encrypted and only shows whose they are.
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
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
  TextArea,
  theme,
} from "@webstudio-is/design-system";
import type { HostInfo } from "@webstudio-is/deploy-protocol";
import { nativeClient } from "~/shared/trpc/trpc-client";
import { $project } from "~/shared/sync/data-stores";
import { sectionSpacing } from "./utils";

type Settings = {
  canManageDeployers: boolean;
  deployers: { id: string; name: string }[];
  target: {
    deployerId: string;
    host: string;
    config: Record<string, unknown>;
    credentials:
      | { status: "none" }
      | { status: "saved"; account?: string }
      | { status: "unreadable" };
  } | null;
};

/** The pasted credentials: undefined when nothing was pasted; throws on invalid JSON. */
const parseCredentials = (text: string) => {
  if (text.trim() === "") {
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("The credentials aren't valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("The credentials must be a JSON object");
  }
  return parsed as Record<string, unknown>;
};

type Field = {
  name: string;
  type: "string" | "boolean" | "json";
  required: boolean;
  description?: string;
};

/** The settings form for a host, from its JSON Schema. */
const getFields = (host: HostInfo): Field[] => {
  const properties = (host.config.properties ?? {}) as Record<
    string,
    { type?: string; description?: string }
  >;
  const required = new Set((host.config.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    type:
      property.type === "string" || property.type === "boolean"
        ? property.type
        : "json",
    required: required.has(name),
    description: property.description,
  }));
};

const toFormValue = (field: Field, value: unknown) =>
  value === undefined
    ? field.type === "boolean"
      ? false
      : ""
    : field.type === "json"
      ? JSON.stringify(value, null, 2)
      : value;

/** Form values back to the host's config; throws on invalid JSON. */
const toConfig = (fields: Field[], values: Record<string, unknown>) => {
  const config: Record<string, unknown> = {};
  for (const field of fields) {
    const value = values[field.name];
    if (field.type === "boolean") {
      config[field.name] = value === true;
    } else if (typeof value === "string" && value.trim() !== "") {
      if (field.type === "json") {
        try {
          config[field.name] = JSON.parse(value);
        } catch {
          throw new Error(`${field.name} isn't valid JSON`);
        }
      } else {
        config[field.name] = value.trim();
      }
    }
  }
  return config;
};

export const SectionDeploy = ({
  projectId: projectIdProp,
}: {
  projectId?: string;
}) => {
  const project = useStore($project);
  const projectId = projectIdProp ?? project?.id ?? "";
  const [settings, setSettings] = useState<Settings>();
  const [deployerId, setDeployerId] = useState<string>();
  const [hosts, setHosts] = useState<HostInfo[]>();
  const [hostId, setHostId] = useState<string>();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [credentialsText, setCredentialsText] = useState("");
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [isSaving, setIsSaving] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    const result = await nativeClient.deployers.projectSettings.query({
      projectId,
    });
    if (result.success === false) {
      throw new Error(result.error);
    }
    setSettings(result.data);
    return result.data;
  }, [projectId]);

  useEffect(() => {
    if (projectId === "") {
      return;
    }
    loadSettings()
      .then(({ target, deployers }) => {
        setDeployerId(target?.deployerId ?? deployers[0]?.id);
        setHostId(target?.host);
        setValues(target?.config ?? {});
      })
      .catch((error: Error) => setError(error.message));
  }, [projectId, loadSettings]);

  useEffect(() => {
    if (deployerId === undefined) {
      return;
    }
    setHosts(undefined);
    nativeClient.deployers.projectHosts
      .query({ projectId, deployerId })
      .then((result) => {
        if (result.success === false) {
          setError(result.error);
          return;
        }
        setError(undefined);
        setHosts(result.data.hosts);
        setHostId((current) =>
          result.data.hosts.some((host) => host.id === current)
            ? current
            : result.data.hosts[0]?.id
        );
      })
      .catch((error: Error) => setError(error.message));
  }, [projectId, deployerId]);

  const host = hosts?.find((host) => host.id === hostId);
  // Saved credentials belong to the saved host.
  const savedCredentials =
    settings?.target?.host === hostId
      ? settings?.target?.credentials
      : undefined;
  const fields = host === undefined ? [] : getFields(host);

  const save = async (remove = false) => {
    setError(undefined);
    setMessage(undefined);
    let target = null;
    if (remove === false) {
      if (deployerId === undefined || host === undefined) {
        return;
      }
      try {
        target = {
          deployerId,
          host: host.id,
          config: toConfig(fields, values),
          // Nothing pasted keeps the saved credentials.
          credentials:
            host.credentials === null
              ? null
              : parseCredentials(credentialsText),
        };
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    setIsSaving(true);
    try {
      const result = await nativeClient.deployers.setProjectTarget.mutate({
        projectId,
        target,
      });
      if (result.success === false) {
        setError(result.error);
        return;
      }
      setCredentialsText("");
      await loadSettings();
      setMessage(remove ? "Deploy target removed." : "Saved.");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Grid gap={2}>
      <Text variant="titles" css={sectionSpacing}>
        Deploy
      </Text>
      <Grid gap={3} css={sectionSpacing}>
        <Text color="subtle">
          Where Publish sends this project. The deployer builds the site and
          uploads it to the host.
        </Text>
        {settings?.deployers.length === 0 && (
          <Text>
            This workspace has no deployers yet.{" "}
            {settings.canManageDeployers
              ? "Add one in the dashboard: workspace menu → Deployers."
              : "Ask a workspace admin to add one."}
          </Text>
        )}
        {settings !== undefined && settings.deployers.length > 0 && (
          <>
            <Grid gap={1}>
              <Label>Deployer</Label>
              <Select
                options={settings.deployers}
                getLabel={(deployer) => deployer.name}
                getValue={(deployer) => deployer.id}
                value={settings.deployers.find(
                  (deployer) => deployer.id === deployerId
                )}
                onChange={(deployer) => setDeployerId(deployer.id)}
              />
            </Grid>
            {hosts === undefined && error === undefined && (
              <Text color="subtle">Asking the deployer for its hosts…</Text>
            )}
            {hosts !== undefined && (
              <Grid gap={1}>
                <Label>Host</Label>
                <Select
                  options={hosts}
                  getLabel={(host) => host.label}
                  getValue={(host) => host.id}
                  value={host}
                  onChange={(next) => setHostId(next.id)}
                />
              </Grid>
            )}
            {fields.map((field) => {
              const id = `deploy-${field.name}`;
              const value = toFormValue(field, values[field.name]);
              const setValue = (next: unknown) =>
                setValues((current) => ({ ...current, [field.name]: next }));
              return (
                <Grid gap={1} key={field.name}>
                  {field.type === "boolean" ? (
                    <CheckboxAndLabel>
                      <Checkbox
                        id={id}
                        checked={value === true}
                        onCheckedChange={(checked) =>
                          setValue(checked === true)
                        }
                      />
                      <Label htmlFor={id}>{field.name}</Label>
                    </CheckboxAndLabel>
                  ) : (
                    <>
                      <Label htmlFor={id}>
                        {field.name}
                        {field.required ? "" : " (optional)"}
                      </Label>
                      {field.type === "json" ? (
                        <TextArea
                          id={id}
                          rows={3}
                          autoGrow
                          value={String(value)}
                          onChange={setValue}
                        />
                      ) : (
                        <InputField
                          id={id}
                          value={String(value)}
                          onChange={(event) => setValue(event.target.value)}
                        />
                      )}
                    </>
                  )}
                  {field.description && (
                    <Text color="subtle">{field.description}</Text>
                  )}
                </Grid>
              );
            })}
            {host?.credentials !== undefined && host.credentials !== null && (
              <Grid gap={1}>
                <Label htmlFor="deploy-credentials">Credentials</Label>
                {savedCredentials?.status === "saved" && (
                  <Text>
                    Saved
                    {savedCredentials.account
                      ? ` for ${savedCredentials.account}`
                      : ""}
                    . Paste new ones to replace them.
                  </Text>
                )}
                {savedCredentials?.status === "unreadable" && (
                  <Text color="destructive">
                    The saved credentials can't be read (the server's
                    DEPLOY_CREDENTIALS_KEY may have changed). Paste them again.
                  </Text>
                )}
                <TextArea
                  id="deploy-credentials"
                  rows={4}
                  value={credentialsText}
                  placeholder="Paste the JSON, or load the file"
                  onChange={setCredentialsText}
                  css={{ fontFamily: theme.fonts.mono }}
                />
                <Flex gap={2} align="center">
                  <Button
                    color="neutral"
                    onClick={() => fileInput.current?.click()}
                  >
                    Load file…
                  </Button>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".json,application/json"
                    hidden
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      file
                        ?.text()
                        .then(setCredentialsText)
                        .catch((error: Error) => setError(error.message));
                    }}
                  />
                </Flex>
                {typeof host.credentials.description === "string" && (
                  <Text color="subtle">{host.credentials.description}</Text>
                )}
                <Text color="subtle">
                  Stored encrypted in the builder's database, where the deployer
                  reads them. They can't be viewed again.
                </Text>
              </Grid>
            )}
            {error && <Text color="destructive">{error}</Text>}
            {message && <Text>{message}</Text>}
            <Flex gap={2} justify="end">
              {settings.target !== null && (
                <Button
                  color="ghost"
                  disabled={isSaving}
                  onClick={() => void save(true)}
                >
                  Remove target
                </Button>
              )}
              <Button
                color="primary"
                disabled={host === undefined}
                state={isSaving ? "pending" : undefined}
                onClick={() => void save()}
              >
                Save
              </Button>
            </Flex>
          </>
        )}
        {settings === undefined && error && (
          <Text color="destructive">{error}</Text>
        )}
      </Grid>
    </Grid>
  );
};
