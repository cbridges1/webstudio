import type { Instance } from "@webstudio-is/sdk";
import { SettingsSection } from "./settings-section";
import { PropsSectionContainer } from "./props-section/props-section";
import { VariablesSection } from "./variables-section";
import { Box, theme } from "@webstudio-is/design-system";
import { useStore } from "@nanostores/react";
import { $isDesignMode } from "~/shared/nano-states";

export const SettingsPanel = ({
  selectedInstance,
  selectedInstanceKey,
}: {
  selectedInstance: Instance;
  selectedInstanceKey: string;
}) => {
  const isDesignMode = useStore($isDesignMode);

  return (
    <Box css={{ pt: theme.spacing[5] }}>
      <SettingsSection />

      <PropsSectionContainer
        selectedInstance={selectedInstance}
        selectedInstanceKey={selectedInstanceKey}
      />

      {isDesignMode && <VariablesSection />}
    </Box>
  );
};
