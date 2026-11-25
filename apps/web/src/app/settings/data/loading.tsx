import { DATA_SUMMARY, DATA_TITLE } from "@/components/settings/data-view";
import { SettingsLoading } from "@/components/settings/settings-frame";

export default function DataLoading() {
  return (
    <SettingsLoading
      current="/settings/data"
      title={DATA_TITLE}
      summary={DATA_SUMMARY}
      reading="Counting what this workspace holds…"
      sections={["What this workspace holds", "Export my data", "Delete my data"]}
    />
  );
}
