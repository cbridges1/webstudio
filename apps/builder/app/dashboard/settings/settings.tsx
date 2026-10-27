// selfhost: the dashboard's Settings page (/dashboard/settings), for app admins: users, the
// deployer and email. A list of sections on the left, the chosen one (kept in ?tab=) on the
// right.
import type { ReactNode } from "react";
import { useSearchParams } from "@remix-run/react";
import {
  Box,
  Flex,
  Grid,
  Text,
  cssVar,
  theme,
} from "@webstudio-is/design-system";
import { CloudIcon, EmailIcon, ShieldIcon } from "@webstudio-is/icons";
import { Header, Main } from "../shared/layout";
import { DeployerSettings } from "./deployer-settings";
import { EmailSettings } from "./email-settings";
import { UsersSettings } from "./users-settings";

const sections = [
  {
    id: "users",
    label: "Users",
    hint: "Accounts and admins",
    icon: <ShieldIcon />,
  },
  {
    id: "deployer",
    label: "Deployer",
    hint: "Where publishes are built",
    icon: <CloudIcon />,
  },
  {
    id: "email",
    label: "Email",
    hint: "Invites and password resets",
    icon: <EmailIcon />,
  },
] as const;

type SectionId = (typeof sections)[number]["id"];

const NavItem = ({
  active,
  icon,
  label,
  hint,
  onSelect,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  hint: string;
  onSelect: () => void;
}) => (
  <Box
    as="button"
    type="button"
    onClick={onSelect}
    aria-current={active ? "page" : undefined}
    css={{
      all: "unset",
      boxSizing: "border-box",
      display: "flex",
      gap: theme.spacing[5],
      alignItems: "flex-start",
      width: "100%",
      padding: `${theme.spacing[5]} ${theme.spacing[7]}`,
      borderRadius: theme.borderRadius[4],
      cursor: "pointer",
      color: active
        ? cssVar("--foreground-primary")
        : cssVar("--foreground-secondary"),
      background: active ? cssVar("--background-secondary") : "transparent",
      boxShadow: active
        ? `inset 2px 0 0 ${cssVar("--background-accent")}`
        : undefined,
      "&:hover": {
        background: active
          ? cssVar("--background-secondary")
          : cssVar("--overlay-interaction-hover"),
        color: cssVar("--foreground-primary"),
      },
      "&:focus-visible": {
        outline: `1px solid ${cssVar("--border-focus")}`,
      },
    }}
  >
    <Flex css={{ paddingTop: 1 }}>{icon}</Flex>
    <Grid gap="1">
      <Text variant="labels" css={{ color: "inherit" }}>
        {label}
      </Text>
      <Text variant="small" color="subtle">
        {hint}
      </Text>
    </Grid>
  </Box>
);

export const Settings = ({ userEmail }: { userEmail?: string }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get("tab");
  const section: SectionId =
    sections.find((item) => item.id === requested)?.id ?? "users";
  const select = (id: SectionId) =>
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous);
        params.set("tab", id);
        return params;
      },
      { replace: true }
    );

  return (
    <Main>
      <Header variant="main">
        <Grid gap="1">
          <Text variant="brandMediumTitle" as="h1" css={{ fontSize: 24 }}>
            Settings
          </Text>
        </Grid>
      </Header>
      <Box
        css={{
          display: "grid",
          gridTemplateColumns: "220px minmax(0, 1fr)",
          gap: theme.spacing[13],
          alignItems: "start",
          paddingInline: theme.spacing[13],
          paddingBottom: theme.spacing[19],
          "@media (max-width: 900px)": { gridTemplateColumns: "1fr" },
        }}
      >
        <Grid
          as="nav"
          aria-label="Settings sections"
          gap="1"
          css={{ position: "sticky", top: theme.spacing[19] }}
        >
          {sections.map((item) => (
            <NavItem
              key={item.id}
              active={item.id === section}
              icon={item.icon}
              label={item.label}
              hint={item.hint}
              onSelect={() => select(item.id)}
            />
          ))}
        </Grid>
        <Box css={{ maxWidth: 760, minWidth: 0 }}>
          {section === "users" && <UsersSettings />}
          {section === "deployer" && <DeployerSettings />}
          {section === "email" && <EmailSettings userEmail={userEmail} />}
        </Box>
      </Box>
    </Main>
  );
};
