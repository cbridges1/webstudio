// selfhost: "Forgot password?" (emails a reset link) and the page that link opens. Shown
// only when the builder can send email.
import { useState } from "react";
import { Form } from "@remix-run/react";
import {
  Button,
  Flex,
  InputField,
  Label,
  Link,
  Text,
  theme,
} from "@webstudio-is/design-system";
import { AuthCard } from "./login";

const fieldCss = {
  height: theme.spacing[15],
  borderRadius: theme.borderRadius[6],
  paddingInline: theme.spacing[3],
  "& input": { fontSize: 14 },
};

const buttonCss = {
  height: theme.spacing[15],
  marginTop: theme.spacing[3],
  borderRadius: theme.borderRadius[6],
};

const BackToSignIn = () => (
  <Text align="center">
    <Link href="/login" color="subtle">
      Back to sign in
    </Link>
  </Text>
);

export type ForgotPasswordProps = {
  isEnabled: boolean;
  sent?: boolean;
  errorMessage?: string;
};

export const ForgotPassword = ({
  isEnabled,
  sent,
  errorMessage,
}: ForgotPasswordProps) => {
  const [isSubmitting, setSubmitting] = useState(false);
  return (
    <AuthCard
      title="Forgot password"
      subtitle="Get a link to choose a new one"
      errorMessage={errorMessage}
    >
      {isEnabled === false ? (
        <Flex direction="column" gap="4">
          <Text align="center">
            This builder can't send email. Ask your administrator to reset your
            password.
          </Text>
          <BackToSignIn />
        </Flex>
      ) : sent ? (
        <Flex direction="column" gap="4">
          <Text align="center">
            If an account has that email, a link to reset its password is on its
            way. It works for one hour.
          </Text>
          <BackToSignIn />
        </Flex>
      ) : (
        <Form method="post" onSubmit={() => setSubmitting(true)}>
          <Flex direction="column" gap="4">
            <Flex direction="column" gap="2">
              <Label htmlFor="reset-email" text="sentence">
                Email
              </Label>
              <InputField
                id="reset-email"
                name="email"
                type="email"
                autoComplete="email"
                required
                autoFocus
                placeholder="The email on your account"
                css={fieldCss}
              />
            </Flex>
            <Button
              color="primary"
              type="submit"
              state={isSubmitting ? "pending" : undefined}
              css={buttonCss}
            >
              Send reset link
            </Button>
            <BackToSignIn />
          </Flex>
        </Form>
      )}
    </AuthCard>
  );
};

export type ResetPasswordProps = {
  token?: string;
  done?: boolean;
  errorMessage?: string;
  minPasswordLength: number;
};

export const ResetPassword = ({
  token,
  done,
  errorMessage,
  minPasswordLength,
}: ResetPasswordProps) => {
  const [isSubmitting, setSubmitting] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  return (
    <AuthCard
      title="Choose a new password"
      subtitle={`At least ${minPasswordLength} characters`}
      errorMessage={mismatch ? "The passwords don't match" : errorMessage}
    >
      {done ? (
        <Flex direction="column" gap="4">
          <Text align="center">Your password was changed.</Text>
          <Text align="center">
            <Link href="/login">Sign in</Link>
          </Text>
        </Flex>
      ) : token === undefined ? (
        <Flex direction="column" gap="4">
          <Text align="center">
            This link isn't complete. Open the link from the email again, or ask
            for a new one.
          </Text>
          <Text align="center">
            <Link href="/login/forgot-password">Get a new link</Link>
          </Text>
        </Flex>
      ) : (
        <Form
          method="post"
          onSubmit={(event) => {
            const form = new FormData(event.currentTarget);
            if (form.get("password") !== form.get("repeat")) {
              event.preventDefault();
              setMismatch(true);
              return;
            }
            setMismatch(false);
            setSubmitting(true);
          }}
        >
          <input type="hidden" name="token" value={token} />
          <Flex direction="column" gap="4">
            <Flex direction="column" gap="2">
              <Label htmlFor="reset-password" text="sentence">
                New password
              </Label>
              <InputField
                id="reset-password"
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={minPasswordLength}
                required
                autoFocus
                css={fieldCss}
              />
            </Flex>
            <Flex direction="column" gap="2">
              <Label htmlFor="reset-repeat" text="sentence">
                Repeat it
              </Label>
              <InputField
                id="reset-repeat"
                name="repeat"
                type="password"
                autoComplete="new-password"
                required
                css={fieldCss}
              />
            </Flex>
            <Button
              color="primary"
              type="submit"
              state={isSubmitting ? "pending" : undefined}
              css={buttonCss}
            >
              Change password
            </Button>
            <BackToSignIn />
          </Flex>
        </Form>
      )}
    </AuthCard>
  );
};
