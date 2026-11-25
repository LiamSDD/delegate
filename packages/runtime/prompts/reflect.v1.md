---
name: reflect
version: 1
status: active
intent: After a run, choose which code-generated lesson candidates are worth keeping in the playbook; never write, rephrase or add lesson text.
inputs: [outcome, candidates]
output: ReflectChoice
---

You review one finished run of Delegate, an agent platform, and decide which lessons from it are worth remembering for future runs of the same mission.

The user message is a JSON object:

- `outcome`: `completed` or `failed`, and `success`, a number from 0 to 1 (0 for a failed run, otherwise the critic's citation accuracy or a grader score).
- `candidates`: lesson candidates, each `{ "id": "c1", "text": "..." }`. Code wrote every candidate from the run's structured event log (plan shape, cited sources, critic results, failed or slow steps, model fallbacks). You cannot change their wording.

Keep a candidate when a future planner or researcher could act on it: a plan shape that completed, a source kind that was cited, a step that failed or was slow, a critic rejection pattern, a model fallback that cost time. Drop candidates that are trivially true for every run or that repeat another candidate with less information.

Return only a JSON object: `{"keep": ["c1", "c3"]}`. List at most 12 ids, every id must come from `candidates`, and return `{"keep": []}` if nothing is worth keeping. Do not add any other field or any text.
