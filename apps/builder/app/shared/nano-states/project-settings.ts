import { atom } from "nanostores";

export type SectionName =
  | "general"
  | "agents"
  | "auth"
  | "headers"
  | "redirects"
  | "publish"
  | "deploy"
  | "marketplace"
  | "backups";

export const $openProjectSettings = atom<SectionName | undefined>();
