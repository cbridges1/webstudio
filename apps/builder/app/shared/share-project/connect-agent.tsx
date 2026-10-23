// selfhost: one step to connect an AI agent (Claude Code, Codex, Cursor, VS Code) to this
// project. It creates (or reuses) the user's agent link and shows one command that runs this
// builder's own CLI (served at /cli/webstudio.json), links a new folder and registers the
// Webstudio MCP server there.
import { useState } from "react";
import {
  Box,
  Button,
  Flex,
  Grid,
  IconButton,
  Label,
  PanelContent,
  Select,
  Text,
  TextArea,
  theme,
} from "@webstudio-is/design-system";
import { AiIcon, CopyIcon } from "@webstudio-is/icons";
import { builderUrl } from "~/shared/router-utils";
import { nativeClient } from "../trpc/trpc-client";
import { CopyToClipboard } from "../copy-to-clipboard";

const clients = {
  claude: {
    label: "Claude Code",
    next: (folder: string) =>
      `Then run \`cd ${folder} && claude\`, approve the "webstudio" server and ask Claude to use Webstudio MCP.`,
  },
  codex: {
    label: "Codex",
    next: (folder: string) =>
      `Then restart Codex, open it in ${folder} and ask it to use Webstudio MCP.`,
  },
  cursor: {
    label: "Cursor",
    next: (folder: string) =>
      `Then open the ${folder} folder in Cursor and enable the webstudio server in MCP settings.`,
  },
  vscode: {
    label: "VS Code",
    next: (folder: string) =>
      `Then open the ${folder} folder in VS Code and start the webstudio server from the MCP view.`,
  },
} as const;

type Client = keyof typeof clients;

const clientNames = Object.keys(clients) as Client[];

type Connection = { link: string; folder: string; cliPackage: string };

const loadConnection = async (projectId: string): Promise<Connection> => {
  const agent = await nativeClient.authorizationToken.agentToken.mutate({
    projectId,
  });
  if (agent === undefined) {
    throw new Error("Couldn't create the agent link");
  }
  const response = await fetch("/cli/webstudio.json");
  const manifest = (await response.json().catch(() => ({}))) as {
    package?: string;
    error?: string;
  };
  if (response.ok === false || manifest.package === undefined) {
    throw new Error(
      manifest.error ??
        "This builder doesn't serve its CLI yet. Run the server's setup again."
    );
  }
  return {
    link: builderUrl({
      projectId,
      origin: window.location.origin,
      authToken: agent.token,
      mode: "design",
    }),
    folder: agent.folder,
    cliPackage: manifest.package,
  };
};

export const ConnectAgent = ({
  projectId,
  onLinkCreated,
}: {
  projectId: string;
  /** The agent link shows in the Share list. */
  onLinkCreated: () => void;
}) => {
  const [connection, setConnection] = useState<Connection>();
  const [client, setClient] = useState<Client>("claude");
  const [error, setError] = useState<string>();
  const [isLoading, setIsLoading] = useState(false);

  const start = async () => {
    setError(undefined);
    setIsLoading(true);
    try {
      setConnection(await loadConnection(projectId));
      onLinkCreated();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  };

  if (connection === undefined) {
    return (
      <PanelContent as={Grid} gap={1} css={{ width: theme.spacing[33] }}>
        <Button
          color="neutral"
          prefix={<AiIcon />}
          state={isLoading ? "pending" : undefined}
          onClick={() => void start()}
        >
          Connect an AI agent
        </Button>
        {error && <Text color="destructive">{error}</Text>}
      </PanelContent>
    );
  }

  const command = `npx -y ${connection.cliPackage} connect ${client} --dir ${connection.folder} --link "${connection.link}"`;

  return (
    <PanelContent as={Grid} gap={2} css={{ width: theme.spacing[33] }}>
      <Flex align="center" justify="between" gap={2}>
        <Label>Connect</Label>
        <Box css={{ width: theme.spacing[22] }}>
          <Select
            options={clientNames}
            getLabel={(name: Client) => clients[name].label}
            value={client}
            onChange={setClient}
          />
        </Box>
      </Flex>
      <Text>Run this in a terminal (Node.js 22 or newer):</Text>
      <Flex gap={1} align="start">
        <TextArea
          value={command}
          readOnly
          rows={6}
          css={{
            fontFamily: theme.fonts.mono,
            flexGrow: 1,
            minWidth: 0,
            wordBreak: "break-all",
          }}
        />
        <CopyToClipboard text={command} copyText="Copy command">
          <IconButton aria-label="Copy command">
            <CopyIcon aria-hidden />
          </IconButton>
        </CopyToClipboard>
      </Flex>
      <Text>{clients[client].next(connection.folder)}</Text>
      <Text color="subtle">
        The command contains your agent link, which can edit this project: treat
        it like a password. Revoke it by deleting "AI agent" from the links
        above.
      </Text>
    </PanelContent>
  );
};
