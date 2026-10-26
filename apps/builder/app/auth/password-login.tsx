// selfhost: username/password sign-in form
import { useState } from "react";
import {
  Button,
  Flex,
  InputField,
  Label,
  Link,
  SmallIconButton,
  Text,
  theme,
} from "@webstudio-is/design-system";
import { EyeClosedIcon, EyeOpenIcon } from "@webstudio-is/icons";
import { authPath } from "~/shared/router-utils";

const fieldCss = {
  height: theme.spacing[15],
  borderRadius: theme.borderRadius[6],
  paddingInline: theme.spacing[3],
  "& input": { fontSize: 14 },
};

export const PasswordLogin = ({
  isPasswordResetEnabled = false,
}: {
  /** selfhost: shows "Forgot password?" when email is set up. */
  isPasswordResetEnabled?: boolean;
}) => {
  const [isPasswordVisible, setPasswordVisible] = useState(false);
  const [isSubmitting, setSubmitting] = useState(false);

  return (
    <form
      method="post"
      action={authPath({ provider: "password" })}
      onSubmit={() => setSubmitting(true)}
      style={{ display: "contents" }}
    >
      <Flex direction="column" gap="4">
        <Flex direction="column" gap="2">
          <Label htmlFor="login-username" text="sentence">
            Username or email
          </Label>
          <InputField
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            autoFocus
            placeholder="Your username or email"
            css={fieldCss}
          />
        </Flex>
        <Flex direction="column" gap="2">
          <Label htmlFor="login-password" text="sentence">
            Password
          </Label>
          <InputField
            id="login-password"
            name="password"
            type={isPasswordVisible ? "text" : "password"}
            autoComplete="current-password"
            required
            placeholder="Your password"
            css={fieldCss}
            suffix={
              <SmallIconButton
                type="button"
                aria-label={
                  isPasswordVisible ? "Hide password" : "Show password"
                }
                aria-pressed={isPasswordVisible}
                icon={isPasswordVisible ? <EyeOpenIcon /> : <EyeClosedIcon />}
                onClick={() => setPasswordVisible((visible) => !visible)}
              />
            }
          />
        </Flex>
        <Button
          color="primary"
          type="submit"
          state={isSubmitting ? "pending" : undefined}
          css={{
            height: theme.spacing[15],
            marginTop: theme.spacing[3],
            borderRadius: theme.borderRadius[6],
          }}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        {isPasswordResetEnabled && (
          <Text align="center">
            <Link href="/login/forgot-password" color="subtle">
              Forgot password?
            </Link>
          </Text>
        )}
        <Text align="center" color="subtle">
          No account yet? Ask your administrator to create one.
        </Text>
      </Flex>
    </form>
  );
};
