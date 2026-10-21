// selfhost: username/password sign-in form
import { Button, Flex, InputField, theme } from "@webstudio-is/design-system";
import { authPath } from "~/shared/router-utils";

export const PasswordLogin = () => {
  return (
    <form
      method="post"
      action={authPath({ provider: "password" })}
      style={{ display: "contents" }}
    >
      <Flex gap="2" direction="column">
        <InputField
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          autoFocus
          placeholder="Username"
          aria-label="Username"
        />
        <InputField
          name="password"
          type="password"
          autoComplete="current-password"
          required
          placeholder="Password"
          aria-label="Password"
        />
        <Button
          color="primary"
          type="submit"
          css={{ height: theme.spacing[15] }}
        >
          Sign in
        </Button>
      </Flex>
    </form>
  );
};
