import type { ReactNode } from "react";
import { TooltipProvider } from "@radix-ui/react-tooltip";
import {
  Box,
  Button,
  Flex,
  Text,
  theme,
  cssVar,
  webstudioBrand,
} from "@webstudio-is/design-system";
import {
  AlertCircleIcon,
  GithubIcon,
  GoogleIcon,
  WebstudioIcon,
} from "@webstudio-is/icons";
import { Form } from "@remix-run/react";
import { authPath } from "~/shared/router-utils";
import { PasswordLogin } from "./password-login";

export type LoginProps = {
  errorMessage?: string;
  isGithubEnabled?: boolean;
  isGoogleEnabled?: boolean;
  isUsernameLoginEnabled?: boolean;
  /** selfhost: email is set up, so "Forgot password?" works. */
  isPasswordResetEnabled?: boolean;
};

export const ErrorBanner = ({ message }: { message: string }) => (
  <Flex
    role="alert"
    align="start"
    gap="2"
    css={{
      padding: `${theme.spacing[6]} ${theme.spacing[7]}`,
      borderRadius: theme.borderRadius[6],
      color: cssVar("--foreground-negative"),
      backgroundColor: `oklch(from ${cssVar("--foreground-negative")} l c h / 10%)`,
      border: `1px solid oklch(from ${cssVar("--foreground-negative")} l c h / 25%)`,
    }}
  >
    <Box css={{ flexShrink: 0, lineHeight: 0, paddingTop: 1 }}>
      <AlertCircleIcon fill="currentColor" />
    </Box>
    <Text color="destructive">{message}</Text>
  </Flex>
);

const Divider = () => (
  <Flex align="center" gap="3">
    <Box
      css={{ flex: 1, height: 1, backgroundColor: cssVar("--border-default") }}
    />
    <Text variant="labels" color="moreSubtle">
      or
    </Text>
    <Box
      css={{ flex: 1, height: 1, backgroundColor: cssVar("--border-default") }}
    />
  </Flex>
);

/** The centered card the sign-in pages share. */
export const AuthCard = ({
  title,
  subtitle,
  errorMessage,
  children,
}: {
  title: string;
  subtitle: string;
  errorMessage?: string;
  children: ReactNode;
}) => (
  <Flex
    align="center"
    justify="center"
    css={{
      minHeight: "100dvh",
      padding: theme.spacing[9],
      boxSizing: "border-box",
      color: cssVar("--foreground-primary"),
      background: webstudioBrand.backgroundGradient,
    }}
  >
    <Flex
      as="main"
      direction="column"
      gap="6"
      css={{
        width: "100%",
        maxWidth: 400,
        boxSizing: "border-box",
        padding: `${theme.spacing[17]} ${theme.spacing[13]}`,
        borderRadius: theme.spacing[9],
        backgroundColor: `oklch(from ${cssVar("--background-primary")} l c h / 82%)`,
        backdropFilter: "blur(24px) saturate(140%)",
        border: `1px solid oklch(from ${cssVar("--border-default")} l c h / 60%)`,
        boxShadow:
          "0 1px 2px #1717170d, 0 12px 32px -8px #17171726, 0 32px 64px -24px #17171733",
        "@media (max-width: 480px)": {
          padding: `${theme.spacing[13]} ${theme.spacing[11]}`,
        },
      }}
    >
      <Flex direction="column" align="center" gap="3">
        <Flex
          align="center"
          justify="center"
          css={{
            width: 64,
            height: 64,
            borderRadius: theme.spacing[9],
            backgroundColor: cssVar("--background-primary"),
            boxShadow: "0 4px 12px #1717171f",
          }}
        >
          <WebstudioIcon size={40} />
        </Flex>
        <Flex direction="column" align="center" gap="1">
          <Text variant="brandSectionTitle" as="h1" align="center">
            {title}
          </Text>
          <Text align="center" color="subtle">
            {subtitle}
          </Text>
        </Flex>
      </Flex>

      {errorMessage ? <ErrorBanner message={errorMessage} /> : null}

      {children}
    </Flex>
  </Flex>
);

export const Login = ({
  errorMessage,
  isGithubEnabled,
  isGoogleEnabled,
  isUsernameLoginEnabled,
  isPasswordResetEnabled,
}: LoginProps) => {
  const isOAuthEnabled = isGoogleEnabled || isGithubEnabled;
  return (
    <AuthCard
      title="Welcome back"
      subtitle="Sign in to continue to Webstudio"
      errorMessage={errorMessage}
    >
      <TooltipProvider>
        <Flex direction="column" gap="4">
          {isUsernameLoginEnabled && (
            <PasswordLogin isPasswordResetEnabled={isPasswordResetEnabled} />
          )}
          {isOAuthEnabled && (
            <>
              {isUsernameLoginEnabled && <Divider />}
              <Form method="post" style={{ display: "contents" }}>
                <Flex direction="column" gap="2">
                  {isGoogleEnabled && (
                    <Button
                      prefix={<GoogleIcon size={20} />}
                      color="neutral"
                      css={{
                        height: theme.spacing[15],
                        borderRadius: theme.borderRadius[6],
                      }}
                      formAction={authPath({ provider: "google" })}
                    >
                      Continue with Google
                    </Button>
                  )}
                  {isGithubEnabled && (
                    <Button
                      prefix={<GithubIcon size={20} fill="currentColor" />}
                      color="neutral"
                      css={{
                        height: theme.spacing[15],
                        borderRadius: theme.borderRadius[6],
                      }}
                      formAction={authPath({ provider: "github" })}
                    >
                      Continue with GitHub
                    </Button>
                  )}
                </Flex>
              </Form>
            </>
          )}
          {isUsernameLoginEnabled !== true && isOAuthEnabled !== true && (
            <Text align="center" color="subtle">
              Sign-in isn't configured. Set AUTH_USERNAME_LOGIN=true in the
              builder's environment.
            </Text>
          )}
        </Flex>
      </TooltipProvider>
    </AuthCard>
  );
};
