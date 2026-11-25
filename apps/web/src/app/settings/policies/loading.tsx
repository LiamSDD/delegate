import { POLICIES_SUMMARY, POLICIES_TITLE } from "@/components/settings/policies-view";
import { SettingsLoading } from "@/components/settings/settings-frame";

export default function PoliciesLoading() {
  return (
    <SettingsLoading
      current="/settings/policies"
      title={POLICIES_TITLE}
      summary={POLICIES_SUMMARY}
      reading="Reading the policy sets for this workspace…"
      sections={["Dry run", "Policy sets that apply"]}
    />
  );
}
