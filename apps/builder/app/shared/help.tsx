import { CloudIcon, ContentIcon, PlayIcon } from "@webstudio-is/icons";

// selfhost: documentation in our repositories, in place of upstream's help, community and
// social links.
const docsUrl = "https://github.com/cbridges1/webstudio/blob/selfhost/docs";

export const help = [
  {
    label: "Getting started",
    url: `${docsUrl}/basics/intro.md`,
    icon: <PlayIcon />,
  },
  {
    label: "Docs",
    url: `${docsUrl}/README.md`,
    icon: <ContentIcon />,
  },
  {
    label: "Self-hosting",
    url: "https://github.com/cbridges1/webstudio/blob/selfhost/README.md#this-fork",
    icon: <CloudIcon />,
  },
] as const;
