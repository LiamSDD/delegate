import { GITHUB_OPEN_PR_TOOL, SIDE_EFFECT_CAPABILITIES } from "@delegate/policy";

import { missionLabel } from "@/lib/m2-contract";
import {
  appliedPolicies,
  CAPABILITY_IDS,
  type PolicyFacts,
  SIMULATED_MISSION_IDS,
} from "@/server/control/policies";

import { PolicySets } from "./policy-sets";
import { PolicySimulator } from "./policy-simulator";
import { SettingsFrame, SettingsSection } from "./settings-frame";

export const POLICIES_TITLE = "What a run may do, and how to check a call";
export const POLICIES_SUMMARY =
  "Every tool call an agent makes is checked by the policy engine before it runs. These are the rules it applies in this workspace, and a dry run to see what it would decide for a call you describe.";

export function PoliciesView({ facts }: { facts: PolicyFacts }) {
  return (
    <SettingsFrame current="/settings/policies" title={POLICIES_TITLE} summary={POLICIES_SUMMARY}>
      <SettingsSection
        id="dry-run"
        title="Dry run"
        lede="Describe a tool call. The server resolves it the way the runtime would and asks the real policy engine. No model is called and nothing leaves Delegate."
      >
        <PolicySimulator
          options={{
            missions: SIMULATED_MISSION_IDS.map((id) => ({ id, label: missionLabel(id) })),
            capabilities: [...CAPABILITY_IDS],
            sideEffectCapabilities: [...SIDE_EFFECT_CAPABILITIES],
            knownTools: [GITHUB_OPEN_PR_TOOL, ...facts.connectorTools.map((tool) => tool.name)],
          }}
        />
      </SettingsSection>
      <SettingsSection
        id="policy-sets"
        title="Policy sets that apply"
        lede="Which set a run gets depends on its mission and on how it was started."
      >
        <PolicySets applied={appliedPolicies(facts)} facts={facts} />
      </SettingsSection>
    </SettingsFrame>
  );
}
