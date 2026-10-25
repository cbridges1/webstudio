import { forwardRef, useState } from "react";
import { ChevronDownIcon } from "@webstudio-is/icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  Avatar,
  theme,
  Button,
  DropdownMenuSeparator,
  Text,
  Flex,
} from "@webstudio-is/design-system";
import { useNavigate } from "@remix-run/react";
import { logoutPath } from "~/shared/router-utils";
import type { User } from "~/shared/db/user.server";
import { ColorSchemeMenu } from "~/shared/color-scheme-menu";
import { DeployerDialog } from "./deployer-dialog";
import { EmailDialog } from "./email-dialog";

const getAvatarLetter = (title?: string) => {
  return (title || "X").charAt(0).toLocaleUpperCase();
};

const defaultUserName = "James Bond";

const ProfileButton = forwardRef<
  HTMLButtonElement,
  {
    name: string;
    image?: string;
  }
>(({ image, name, ...rest }, forwardedRef) => {
  return (
    <Flex gap="2" align="center">
      <Button
        color="ghost"
        aria-label="Profile menu"
        {...rest}
        ref={forwardedRef}
        prefix={
          <Avatar src={image} fallback={getAvatarLetter(name)} alt={name} />
        }
        suffix={<ChevronDownIcon size={12} />}
        css={{
          // Exception for avatar. May need to introduce a 32px controls size later.
          height: theme.spacing[13],
        }}
      >
        {name && (
          <Text variant="labels" truncate>
            {name}
          </Text>
        )}
      </Button>
    </Flex>
  );
});

export const ProfileMenu = ({
  user,
  isAdmin,
}: {
  user: User;
  /** selfhost: app admins set up the deployer. */
  isAdmin: boolean;
}) => {
  const navigate = useNavigate();
  const nameOrEmail = user.username ?? user.email ?? defaultUserName;
  const [deployerOpen, setDeployerOpen] = useState(false);
  const [emailOpen, setEmailOpen] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <ProfileButton image={user.image || undefined} name={nameOrEmail} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} width="regular">
          <DropdownMenuLabel>
            {user.username ?? defaultUserName}
            <Text>{user.email}</Text>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <ColorSchemeMenu />
          <DropdownMenuSeparator />
          {isAdmin && (
            <>
              <DropdownMenuItem onSelect={() => setDeployerOpen(true)}>
                Deployer
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setEmailOpen(true)}>
                Email
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={() => navigate(logoutPath())}>
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {isAdmin && (
        <>
          <DeployerDialog
            isOpen={deployerOpen}
            onOpenChange={setDeployerOpen}
          />
          <EmailDialog
            isOpen={emailOpen}
            onOpenChange={setEmailOpen}
            userEmail={user.email ?? undefined}
          />
        </>
      )}
    </>
  );
};
