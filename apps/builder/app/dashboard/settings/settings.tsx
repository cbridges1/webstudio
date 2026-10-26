// selfhost: the dashboard's Settings page (/dashboard/settings), for app admins: users, the
// deployer and email. The tab is kept in ?tab=.
import { useSearchParams } from "@remix-run/react";
import {
  Flex,
  PanelTabs,
  PanelTabsContent,
  PanelTabsList,
  PanelTabsTrigger,
  Text,
  theme,
} from "@webstudio-is/design-system";
import { Header, Main } from "../shared/layout";
import { DeployerSettings } from "./deployer-settings";
import { EmailSettings } from "./email-settings";
import { UsersSettings } from "./users-settings";

const tabs = ["users", "deployer", "email"] as const;
type Tab = (typeof tabs)[number];

const tabLabels: Record<Tab, string> = {
  users: "Users",
  deployer: "Deployer",
  email: "Email",
};

export const Settings = ({ userEmail }: { userEmail?: string }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const tab: Tab = tabs.includes(requested as Tab)
    ? (requested as Tab)
    : "users";
  return (
    <Main>
      <Header variant="main">
        <Text variant="brandSectionTitle" as="h1">
          Settings
        </Text>
      </Header>
      <PanelTabs
        value={tab}
        onValueChange={(next) =>
          setSearchParams(
            (previous) => {
              const params = new URLSearchParams(previous);
              params.set("tab", next);
              return params;
            },
            { replace: true }
          )
        }
        css={{ paddingInline: theme.spacing[11] }}
      >
        <PanelTabsList>
          {tabs.map((value) => (
            <PanelTabsTrigger key={value} value={value}>
              {tabLabels[value]}
            </PanelTabsTrigger>
          ))}
        </PanelTabsList>
        <Flex
          direction="column"
          css={{
            paddingInline: theme.spacing[5],
            paddingBottom: theme.spacing[13],
            maxWidth: 720,
          }}
        >
          <PanelTabsContent value="users">
            <UsersSettings />
          </PanelTabsContent>
          <PanelTabsContent value="deployer">
            <DeployerSettings />
          </PanelTabsContent>
          <PanelTabsContent value="email">
            <EmailSettings userEmail={userEmail} />
          </PanelTabsContent>
        </Flex>
      </PanelTabs>
    </Main>
  );
};
