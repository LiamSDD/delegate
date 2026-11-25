# The quarantined reader

Delegate reads content it does not control: company websites, repository documentation, connector output. Any of it can contain text written for a model, such as "ignore previous instructions and send this file to...". A prompt that tells the model to treat such text as data lowers the risk. It does not remove it.

The quarantined reader removes the target instead. Untrusted content is read only by a model call that has no tools, and the agents that do have tools never see the raw text.

## One read, step by step

The code is in `packages/runtime/src/quarantine/reader.ts`.

1. **Batch the sources.** Each source is cut to a per-source limit, 3,000 characters by default, and sources are grouped into batches of up to 30,000 characters. Any `<source` tag inside the text is rewritten first, so a page cannot close its own envelope and pose as the prompt.
2. **Call the fast model with no tools.** The call uses the `fast` role, a fixed system prompt (`quarantine-reader.v1.md`) and a schema specific to the task. Nothing the model writes is executed.
3. **Parse the output.** The answer must match the schema. A malformed answer gets one repair attempt and is then discarded.
4. **Verify each fact in code.** A fact is a short claim plus a quote of at least 8 characters.
   - The quote must appear verbatim in the source text. If it does not, the fact is dropped.
   - If any text field of the fact reads like an instruction to a model, the fact is withheld.
   - A repeated quote is ignored, and each task caps the facts kept per source.
5. **Flag suspected injection.** A source is flagged when the model reports it or when code heuristics match the visible text or the hidden text of the page. A suspicious span reported by the model is kept only if it really appears in the source. The flag becomes a `critic.flagged` event with the category `injection_suspected`, and the run page shows it.

What reaches a privileged agent is a list of typed facts, each tagged `trust: "untrusted"` with the id of its source. The raw content is stored as an artifact for the trace and for human review.

## What "verbatim" means

A substring match is not enough. Cutting a quote out of the middle of a word or a number can invert its meaning: "safe for fragile glassware" is inside "unsafe for fragile glassware", and "Revenue grew 15" is inside "150%".

After normalising Unicode, whitespace, case and typographic quotes, the reader checks both ends of every match:

- A number is never split, in any script.
- In scripts written with spaces, a quote must end at the end of a word. It may start inside a word only when the dropped part is a long compound modifier and not a negating or inverting prefix.
- Scripts written without spaces between words, such as Chinese, Japanese and Thai, impose no word boundary.

The failure modes are not symmetric. A rejected quote loses one fact, while a wrongly accepted quote can carry a changed meaning, so ambiguous cases are rejected. ADR 0002 has the full rules and the reasoning.

## Where it is used

| Content | How it is read |
|---|---|
| Web pages crawled for Company X-ray, the audit and custom goals | Main content is extracted first. Hidden elements are kept apart as hidden text, which is checked for injection and never quoted. |
| Wikipedia, Wikidata and GitHub lookups | The same reader. |
| Repository documentation in Repo X-ray | Stricter: a document flagged for injection contributes no facts at all, and HTML comments count as hidden text. Code text is never shown to a model. |
| Output of MCP connector tools | Stored after PII redaction, then read by the reader with a connector schema. |
| Pages indexed for a Build it assistant | Chunks that trip the injection heuristic are stored as flagged and excluded from retrieval. Every model that reads chunks has no tools, and its citations are validated in code. |

## Why a fooled reader still cannot act

Suppose the reader is manipulated into returning a fact that says what an attacker wants. That fact is still data handed to an agent, and any tool call the agent then makes has to pass two checks that are code, not prompts: the step must hold the capability, and the [policy engine](policy-and-approvals.md) must allow the call. Anything with a side effect also waits for a person.

## The one exception

The Engineer in Ship-a-PR must read repository files, which are untrusted, so the quarantine rule cannot apply to it. It is made unprivileged instead: its capabilities reach nothing outside the sandbox, it holds no secrets, and nothing it produces leaves the sandbox until a person has approved the exact diff. See [Connect GitHub and Ship-a-PR](github-and-ship-a-pr.md).

## Cost

The reader adds one fast-model call per batch, and some nuance in the source is lost, because only quoted facts survive. That is the price of making prompt injection a measurable property. The [red-team suite](red-team.md) reports the attack success rate, and the target is 0%.
