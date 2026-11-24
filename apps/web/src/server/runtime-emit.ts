import type { RunEventDraft } from "@delegate/runtime";

import type { EventDraft } from "./runs";

export function adaptRuntimeEmit(
  runId: string,
  sink: (draft: EventDraft) => Promise<void>,
): (draft: RunEventDraft) => Promise<void> {
  return (draft) => {
    if (draft.runId !== runId) {
      return Promise.reject(
        new Error(`runtime emitted an event for run ${draft.runId} inside run ${runId}`),
      );
    }
    return sink({
      type: draft.type,
      payload: draft.payload,
      ...(draft.stepId === undefined ? {} : { stepId: draft.stepId }),
      ...(draft.agentId === undefined ? {} : { agentId: draft.agentId }),
    });
  };
}
