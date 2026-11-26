import Link from "next/link";

import { AutomationPanel, type AutomationState } from "./automation-panel";
import { SettingsFrame, SettingsSection } from "./settings-frame";

export const AUTOMATION_TITLE = "What may be approved without asking";
export const AUTOMATION_SUMMARY =
  "By default Delegate asks before it follows a plan and before any connector tool with a side effect. These defaults let you skip the question where you trust the answer.";

export const NO_AUTOMATION: AutomationState = {
  autoApprovePlans: false,
  preapprovedTools: [],
  changedTools: [],
};

export function AutomationView({ automation }: { automation: AutomationState }) {
  return (
    <SettingsFrame
      current="/settings/automation"
      title={AUTOMATION_TITLE}
      summary={AUTOMATION_SUMMARY}
    >
      <SettingsSection
        id="defaults"
        title="Automation defaults"
        lede={
          <>
            Stored with the workspace and applied on the server. Neither default approves shipping a
            change: that always waits for a person who has seen the diff. What is waiting right now
            is in the{" "}
            <Link
              href="/control#approvals"
              className="text-text underline decoration-border-strong underline-offset-4 hover:text-accent"
            >
              approvals inbox
            </Link>
            .
          </>
        }
      >
        <AutomationPanel initial={automation} />
      </SettingsSection>
    </SettingsFrame>
  );
}
