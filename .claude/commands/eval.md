---
description: Run the eval suite for a mission and compare against the last baseline
---
Run `pnpm eval --mission ${ARGUMENTS:-all}` (available from M1). Then use the `eval-analyst` agent to compare with the previous baseline in `packages/evals/results/`: pass rate and citation accuracy as mean ± 95% CI, cost and latency per mission, serving models, and whether any change is statistically meaningful. Record the summary in `docs/PROGRESS.md`.
