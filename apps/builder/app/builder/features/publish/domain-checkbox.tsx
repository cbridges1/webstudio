import { useStore } from "@nanostores/react";
import { Tooltip, Text, Checkbox } from "@webstudio-is/design-system";

import { $project } from "~/shared/sync/data-stores";
import { $permissions } from "~/shared/nano-states";

export const domainToPublishName = "domainToPublish[]";

/**
 * Pure function: returns true when a custom domain checkbox should be disabled
 * because the builder role can only publish to staging.
 *
 * Staging domains are always unrestricted — this function returns false for them.
 */
const isCustomDomainPublishRestricted = ({
  canPublishToStagingOnly,
  isCustomDomain,
}: {
  canPublishToStagingOnly: boolean;
  isCustomDomain: boolean | undefined;
}) => canPublishToStagingOnly && isCustomDomain === true;

export const __testing__ = { isCustomDomainPublishRestricted };

interface DomainCheckboxProps {
  defaultChecked?: boolean;
  domain: string;
  buildId: string | undefined;
  disabled?: boolean;
  isCustomDomain?: boolean;
}

export const DomainCheckbox = (props: DomainCheckboxProps) => {
  const { canPublishToStagingOnly } = useStore($permissions);
  const project = useStore($project);

  if (project === undefined) {
    return;
  }

  const tooltipContent =
    canPublishToStagingOnly && props.isCustomDomain ? (
      <Text>
        Builders can only publish to staging. Contact the project owner or an
        admin to publish to custom domains.
      </Text>
    ) : undefined;

  // For builders: custom domains are disabled (staging-only permission).
  // Staging domain behaves normally — user can still check/uncheck it.
  const isRestricted = isCustomDomainPublishRestricted({
    canPublishToStagingOnly,
    isCustomDomain: props.isCustomDomain,
  });
  const defaultChecked = isRestricted ? false : props.defaultChecked;
  const disabled = isRestricted ? true : props.disabled;

  // With only the staging domain there is nothing to choose, so it is always
  // published and the checkbox is hidden.
  const hideDomainCheckbox =
    project.domainsVirtual.filter(
      (domain) => domain.status === "ACTIVE" && domain.verified
    ).length === 0;

  return (
    <div style={{ display: hideDomainCheckbox ? "none" : "contents" }}>
      <Tooltip content={tooltipContent} variant="wrapped">
        <Checkbox
          disabled={disabled}
          key={props.buildId ?? "-"}
          defaultChecked={hideDomainCheckbox || defaultChecked}
          css={{ pointerEvents: "all" }}
          name={domainToPublishName}
          value={props.domain}
        />
      </Tooltip>
    </div>
  );
};
