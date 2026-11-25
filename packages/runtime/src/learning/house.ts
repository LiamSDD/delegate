import { PlaybookKeySchema, playbookKey } from "./lessons";
import { PlaybookSchema, type Playbook } from "./playbook";

export const HOUSE_PLAYBOOK_SUFFIX = ".house.json";

export function housePlaybookFileName(key: string): string {
  return `${PlaybookKeySchema.parse(key).replace(":", ".")}${HOUSE_PLAYBOOK_SUFFIX}`;
}

export function housePlaybookKeyOfFile(fileName: string): string | undefined {
  if (!fileName.endsWith(HOUSE_PLAYBOOK_SUFFIX)) return undefined;
  const key = fileName.slice(0, -HOUSE_PLAYBOOK_SUFFIX.length).replace(".", ":");
  return PlaybookKeySchema.safeParse(key).success && housePlaybookFileName(key) === fileName
    ? key
    : undefined;
}

export function parseHousePlaybook(key: string, raw: string): Playbook | null {
  try {
    const parsed = PlaybookSchema.safeParse(JSON.parse(raw) as unknown);
    return parsed.success && parsed.data.key === key && parsed.data.scope === "house"
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export function housePlaybookKeys(missionId: string, inputs: readonly unknown[]): string[] {
  return [...new Set(inputs.map((input) => playbookKey(missionId, input)))].sort();
}
