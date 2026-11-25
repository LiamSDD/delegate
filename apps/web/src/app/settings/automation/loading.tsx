import { AUTOMATION_SUMMARY, AUTOMATION_TITLE } from "@/components/settings/automation-view";
import { SettingsLoading } from "@/components/settings/settings-frame";

export default function AutomationLoading() {
  return (
    <SettingsLoading
      current="/settings/automation"
      title={AUTOMATION_TITLE}
      summary={AUTOMATION_SUMMARY}
      reading="Reading the automation defaults…"
      sections={["Automation defaults"]}
    />
  );
}
