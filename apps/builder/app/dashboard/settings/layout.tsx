// selfhost: building blocks shared by the Settings sections: a section heading, cards with a
// title, a description and a footer for their actions, notices, badges and form fields.
import type { ComponentProps, ReactNode } from "react";
import {
  Box,
  Flex,
  Grid,
  InputField,
  Label,
  Text,
  cssVar,
  theme,
} from "@webstudio-is/design-system";

/** The section's title and what it's for, above its cards. */
export const SectionHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description: ReactNode;
  actions?: ReactNode;
}) => (
  <Flex justify="between" align="end" gap="5" css={{ flexWrap: "wrap" }}>
    <Grid gap="2" css={{ maxWidth: 560 }}>
      <Text variant="brandSectionTitle" as="h2">
        {title}
      </Text>
      <Text color="subtle" css={{ lineHeight: 1.6 }}>
        {description}
      </Text>
    </Grid>
    {actions && <Flex gap="2">{actions}</Flex>}
  </Flex>
);

/** A bordered group of related settings, with its own actions in the footer. */
export const SettingsCard = ({
  title,
  description,
  actions,
  footer,
  children,
  flush = false,
}: {
  title: string;
  description?: ReactNode;
  /** Small controls next to the title (a badge, Refresh). */
  actions?: ReactNode;
  /** The card's buttons, right-aligned under a divider. */
  footer?: ReactNode;
  children?: ReactNode;
  /** No padding around the body, for lists that run edge to edge. */
  flush?: boolean;
}) => (
  <Box
    as="section"
    css={{
      border: `1px solid ${cssVar("--border-default")}`,
      borderRadius: theme.borderRadius[5],
      background: cssVar("--background-primary"),
      overflow: "hidden",
    }}
  >
    <Flex
      justify="between"
      align="start"
      gap="5"
      css={{ padding: `${theme.spacing[9]} ${theme.spacing[10]}` }}
    >
      <Grid gap="2">
        <Text variant="titles" as="h3" css={{ fontSize: 13 }}>
          {title}
        </Text>
        {description && (
          <Text color="subtle" css={{ lineHeight: 1.6, maxWidth: 520 }}>
            {description}
          </Text>
        )}
      </Grid>
      {actions && (
        <Flex gap="2" align="center" shrink={false}>
          {actions}
        </Flex>
      )}
    </Flex>
    {children !== undefined && (
      <Box
        css={
          flush
            ? { borderTop: `1px solid ${cssVar("--border-default")}` }
            : {
                padding: `0 ${theme.spacing[10]} ${theme.spacing[10]}`,
              }
        }
      >
        {children}
      </Box>
    )}
    {footer && (
      <Flex
        justify="end"
        align="center"
        gap="2"
        css={{
          padding: `${theme.spacing[7]} ${theme.spacing[10]}`,
          borderTop: `1px solid ${cssVar("--border-default")}`,
          background: cssVar("--background-secondary"),
        }}
      >
        {footer}
      </Flex>
    )}
  </Box>
);

const noticeColors = {
  info: {
    background: cssVar("--background-secondary"),
    color: cssVar("--foreground-primary"),
  },
  success: {
    background: cssVar("--background-positive-subtle"),
    color: cssVar("--foreground-primary"),
  },
  warning: {
    background: cssVar("--background-warning-subtle"),
    color: cssVar("--foreground-primary"),
  },
  error: {
    background: cssVar("--background-negative-subtle"),
    color: cssVar("--foreground-negative"),
  },
};

/** A one-line message in a tinted box: saved, failed, set by the environment. */
export const Notice = ({
  tone = "info",
  children,
}: {
  tone?: keyof typeof noticeColors;
  children: ReactNode;
}) => (
  <Box
    role={tone === "error" ? "alert" : "status"}
    css={{
      ...noticeColors[tone],
      borderRadius: theme.borderRadius[4],
      padding: `${theme.spacing[5]} ${theme.spacing[7]}`,
      lineHeight: 1.6,
    }}
  >
    <Text css={{ color: "inherit", lineHeight: "inherit" }}>{children}</Text>
  </Box>
);

const badgeColors = {
  neutral: {
    background: cssVar("--background-secondary"),
    color: cssVar("--foreground-secondary"),
    border: `1px solid ${cssVar("--border-default")}`,
  },
  accent: {
    background: cssVar("--background-accent"),
    color: cssVar("--foreground-on-accent"),
    border: "1px solid transparent",
  },
  positive: {
    background: cssVar("--background-positive-subtle"),
    color: cssVar("--foreground-positive"),
    border: "1px solid transparent",
  },
  negative: {
    background: cssVar("--background-negative-subtle"),
    color: cssVar("--foreground-negative"),
    border: "1px solid transparent",
  },
};

/** A small label: a role, a status. */
export const Badge = ({
  tone = "neutral",
  children,
}: {
  tone?: keyof typeof badgeColors;
  children: ReactNode;
}) => (
  <Box
    as="span"
    css={{
      ...badgeColors[tone],
      display: "inline-flex",
      alignItems: "center",
      height: 20,
      paddingInline: theme.spacing[4],
      borderRadius: theme.borderRadius[3],
      fontSize: 11,
      fontWeight: 500,
      whiteSpace: "nowrap",
    }}
  >
    {children}
  </Box>
);

/** Green when running, grey when not. */
export const StatusDot = ({ on }: { on: boolean }) => (
  <Box
    aria-hidden
    css={{
      width: 8,
      height: 8,
      borderRadius: "50%",
      flexShrink: 0,
      background: on
        ? cssVar("--foreground-positive")
        : cssVar("--foreground-disabled"),
      boxShadow: on
        ? `0 0 0 3px ${cssVar("--background-positive-subtle")}`
        : undefined,
    }}
  />
);

/** A labelled input with an optional hint underneath. */
export const Field = ({
  id,
  label,
  hint,
  css,
  ...props
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  css?: ComponentProps<typeof Grid>["css"];
} & Omit<ComponentProps<typeof InputField>, "css">) => (
  // Fields side by side keep their inputs level when only one has a hint.
  <Grid gap="2" css={{ alignContent: "start", ...css }}>
    <Label htmlFor={id}>{label}</Label>
    <InputField id={id} {...props} />
    {hint && (
      <Text color="subtle" variant="small" css={{ lineHeight: 1.5 }}>
        {hint}
      </Text>
    )}
  </Grid>
);

/** Two columns of fields (pairs: server and port, username and password) that stack on narrow screens. */
export const FieldGrid = ({ children }: { children: ReactNode }) => (
  <Grid
    css={{
      gap: `${theme.spacing[9]} ${theme.spacing[9]}`,
      gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
      "@media (max-width: 640px)": { gridTemplateColumns: "1fr" },
    }}
  >
    {children}
  </Grid>
);
