import { CAPABILITIES, GITHUB_API_HOST, GITHUB_OPEN_PR_TOOL, evaluate } from "@delegate/policy";

import { RunAbortedError, type RunContext } from "../../agent/context";
import { runAgentLoop } from "../../agent/loop";
import {
  runPlannedMission,
  stepFailure,
  type PlannedMission,
  type PlannedRunOptions,
} from "../../agent/mission-runner";
import { missionClock } from "../../agent/pacing";
import { FatalStepError, type StepExecutor, type SubAgentResult } from "../../agent/subagent";
import { type ExistingArtifact } from "../../durable/checkpoints";
import { type Actor, type ShipMode } from "../../events";
import {
  GitHubApiError,
  parseGitHubRepoUrl,
  repoFullName,
  type GitHubAppClient,
  type RepoRef,
  type RepoSession,
} from "../../github/app";
import { type PromptFile } from "../../prompts";
import { type ChatMessage } from "../../providers/types";
import { SandboxUnavailableError, type Sandbox, type SandboxProvider } from "../../sandbox/types";
import { commandLabel, detectProject, type ProjectProfile } from "./detect";
import { type ShipAPrInput } from "./input";
import { SHIP_PLANNING_HINTS, SHIP_STEP_IDS, SHIP_CAPABILITIES, shipPlan } from "./plan";
import {
  approvalIdFor,
  branchName,
  commitMessage,
  describeRun,
  pullRequestBody,
  slug,
  testReportText,
} from "./pr";
import {
  SHIP_DIFF_KIND,
  SHIP_RESULT_KIND,
  SHIP_TEST_REPORT_KIND,
  SHIP_WORKSPACE_KIND,
  ShipDecisionSchema,
  ShipDiffSchema,
  ShipResultSchema,
  ShipTestReportSchema,
  ShipWorkspaceSchema,
  type AwaitShipApproval,
  type ShipDecision,
  type ShipDiff,
  type ShipResult,
  type ShipTestReport,
  type ShipWorkspace,
} from "./schema";
import { createEngineerTools } from "./tools";
import {
  SHIP_TIMEOUTS,
  WorkspaceError,
  applyRecordedPatch,
  cloneRepository,
  collectDiff,
  commandSummary,
  fileChanges,
  readProjectFiles,
  runInSandbox,
  runProjectCommand,
  snapshotTree,
  type CommandRun,
} from "./workspace";

export const SHIP_LIMITS = {
  targetMs: 20 * 60_000,
  engineerMs: 12 * 60_000,
  rounds: 3,
  iterationsPerRound: 10,
  toolCallsPerRound: 30,
  maxTokensPerCall: 4_000,
  feedbackChars: 2_500,
} as const;

export type ShipLimits = { -readonly [K in keyof typeof SHIP_LIMITS]: number };

export const DEFAULT_SHIP_REVIEWER: Actor = { type: "member", id: "ship-reviewer" };
export const SHIP_SYSTEM_ACTOR: Actor = { type: "system", id: "ship-a-pr" };
export const NO_REVIEWER_REASON =
  "No reviewer is attached to this run (CLI, API or evals), so nothing was shipped.";

export interface ShipAPrPrompts {
  planner: PromptFile;
  engineer: PromptFile;
}

export interface ShipAPrDependencies {
  ctx: RunContext;
  input: ShipAPrInput;
  prompts: ShipAPrPrompts;
  sandboxes: SandboxProvider;
  github: GitHubAppClient | null;
  cloneUrl?: (repo: RepoRef) => string;
  awaitShipApproval?: AwaitShipApproval;
  existingArtifacts?: readonly ExistingArtifact[];
  limits?: Partial<ShipLimits>;
  run?: Omit<PlannedRunOptions, "plannerPrompt">;
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function result(summary: string, artifacts: string[], confidence = 1): SubAgentResult {
  return { summary: cut(summary, 1000), findings: [], sources: [], confidence, artifacts };
}

export function defaultCloneUrl(repo: RepoRef): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

function fatalFrom(error: unknown): never {
  if (error instanceof FatalStepError || error instanceof RunAbortedError) throw error;
  if (error instanceof SandboxUnavailableError)
    throw new FatalStepError("sandbox_unavailable", error.message);
  if (error instanceof WorkspaceError) throw new FatalStepError(error.code, error.message);
  throw error;
}

export function createShipAPrMission(deps: ShipAPrDependencies): PlannedMission & {
  close: () => Promise<void>;
} {
  const { ctx, input } = deps;
  const limits: ShipLimits = { ...SHIP_LIMITS, ...deps.limits };
  const emit = ctx.emitter.emit.bind(ctx.emitter);
  const runId = ctx.runId;
  const clock = missionClock(ctx, limits.targetMs);
  const repoRef = parseGitHubRepoUrl(input.repoUrl);
  if (repoRef === null) throw new FatalStepError("invalid_input", "Not a GitHub repository URL");
  const repo = repoFullName(repoRef);
  const cloneUrl = (deps.cloneUrl ?? defaultCloneUrl)(repoRef);
  const improvement = input.improvement;
  const artifacts = new Map<string, ExistingArtifact>();
  for (const artifact of deps.existingArtifacts ?? []) artifacts.set(artifact.artifactId, artifact);
  let live: Sandbox | undefined;

  const latest = (kind: string, stepId?: string): ExistingArtifact | undefined =>
    [...artifacts.values()]
      .filter(
        (artifact) =>
          artifact.kind === kind && (stepId === undefined || artifact.stepId === stepId),
      )
      .at(-1);

  const publish = async (stepId: string, kind: string, title: string, content: unknown) => {
    const previous = latest(kind, stepId);
    if (previous !== undefined) {
      const version = previous.version + 1;
      artifacts.set(previous.artifactId, { ...previous, version, content });
      await emit({
        runId,
        type: "artifact.updated",
        stepId,
        payload: { artifactId: previous.artifactId, version, content },
      });
      return previous.artifactId;
    }
    const artifactId = crypto.randomUUID();
    artifacts.set(artifactId, { artifactId, kind, version: 1, content, stepId });
    await emit({
      runId,
      type: "artifact.created",
      stepId,
      payload: { artifactId, kind, title: cut(title, 200), version: 1, content },
    });
    return artifactId;
  };

  const workspaceInfo = (): { id: string; info: ShipWorkspace } => {
    const artifact = latest(SHIP_WORKSPACE_KIND);
    if (artifact === undefined)
      throw new FatalStepError("workspace_missing", "No sandbox workspace was prepared");
    return { id: artifact.artifactId, info: ShipWorkspaceSchema.parse(artifact.content) };
  };
  const report = (stepId: string): ShipTestReport | undefined => {
    const artifact = latest(SHIP_TEST_REPORT_KIND, stepId);
    return artifact === undefined ? undefined : ShipTestReportSchema.parse(artifact.content);
  };
  const diffArtifact = (): { id: string; diff: ShipDiff } | undefined => {
    const artifact = latest(SHIP_DIFF_KIND);
    return artifact === undefined
      ? undefined
      : { id: artifact.artifactId, diff: ShipDiffSchema.parse(artifact.content) };
  };

  const install = async (sandbox: Sandbox, stepId: string, profile: ProjectProfile) => {
    if (profile.commands.install === null) return null;
    const run = await runProjectCommand(
      ctx,
      sandbox,
      stepId,
      "install",
      profile.commands.install,
      SHIP_TIMEOUTS.installMs,
    );
    if (run.exitCode !== 0)
      throw new FatalStepError(
        "install_failed",
        `${commandLabel(profile.commands.install)} ${run.timedOut ? "timed out" : `exited with ${run.exitCode ?? "?"}`}: ${cut(run.output.slice(-400), 400)}`,
      );
    return run;
  };

  const rebuild = async (stepId: string, info: ShipWorkspace): Promise<Sandbox> => {
    const sandbox = await deps.sandboxes.create(
      ctx.signal === undefined ? {} : { signal: ctx.signal },
    );
    try {
      await sandbox.setNetwork("setup");
      const sha = await cloneRepository(ctx, sandbox, stepId, { url: cloneUrl, ref: info.baseSha });
      if (sha !== info.baseSha)
        throw new FatalStepError(
          "resume_failed",
          "The repository no longer has the recorded commit",
        );
      await install(sandbox, stepId, info.profile);
      const baselineTree = await snapshotTree(sandbox);
      await sandbox.setNetwork("work");
      const recorded = diffArtifact();
      if (recorded !== undefined)
        await applyRecordedPatch(ctx, sandbox, stepId, recorded.diff.patch);
      await publish(SHIP_STEP_IDS.prepare, SHIP_WORKSPACE_KIND, `Sandbox for ${repo}`, {
        ...info,
        sandboxKind: deps.sandboxes.kind,
        sandboxId: sandbox.id,
        baselineTree,
      });
      return sandbox;
    } catch (error) {
      await sandbox.close();
      throw error;
    }
  };

  const workspace = async (stepId: string): Promise<Sandbox> => {
    if (live !== undefined) return live;
    const { info } = workspaceInfo();
    try {
      const attached =
        info.sandboxKind === deps.sandboxes.kind
          ? await deps.sandboxes.attach(info.sandboxId)
          : null;
      if (attached !== null) {
        const head = await attached
          .exec({ cmd: "git", args: ["rev-parse", "HEAD"], timeoutMs: SHIP_TIMEOUTS.gitMs })
          .catch(() => null);
        if (head?.exitCode === 0 && head.stdout.trim() === info.baseSha) {
          live = attached;
          return attached;
        }
      }
      live = await rebuild(stepId, info);
      return live;
    } catch (error) {
      return fatalFrom(error);
    }
  };

  const runChecks = async (
    sandbox: Sandbox,
    stepId: string,
    purpose: "baseline" | "verify",
    profile: ProjectProfile,
  ): Promise<ShipTestReport> => {
    const run = async (command: ProjectProfile["commands"]["test"]): Promise<CommandRun | null> =>
      command === null
        ? null
        : runProjectCommand(ctx, sandbox, stepId, purpose, command, SHIP_TIMEOUTS.testMs);
    const test = await run(profile.commands.test);
    const lint = await run(profile.commands.lint);
    const typecheck = await run(profile.commands.typecheck);
    return {
      phase: purpose === "baseline" ? "baseline" : "after",
      test: commandSummary(test),
      lint: lint === null ? null : commandSummary(lint),
      typecheck: typecheck === null ? null : commandSummary(typecheck),
      testOutput: test?.output ?? "",
    };
  };

  const prepare: StepExecutor = {
    id: SHIP_STEP_IDS.prepare,
    role: "builder",
    modelRole: "fast",
    capabilities: [CAPABILITIES.sandboxExec],
    required: true,
    description:
      "Creates the sandbox, clones the repository over HTTPS at the ref, detects the package manager and commands from package.json, pyproject.toml or the Makefile, installs dependencies, then restricts the sandbox network to package registries.",
    run: async (task) => {
      const existing = latest(SHIP_WORKSPACE_KIND);
      if (existing !== undefined) {
        await workspace(task.step.id);
        const { id, info } = workspaceInfo();
        return result(`Reattached the sandbox for ${repo} at ${info.baseSha.slice(0, 7)}`, [id]);
      }
      await task.agent.say(
        `Creating a ${deps.sandboxes.kind} sandbox and cloning ${repo}${input.ref === undefined ? "" : ` at ${input.ref}`}.`,
      );
      let sandbox: Sandbox;
      try {
        sandbox = await deps.sandboxes.create(
          ctx.signal === undefined ? {} : { signal: ctx.signal },
        );
      } catch (error) {
        return fatalFrom(error);
      }
      live = sandbox;
      try {
        await sandbox.setNetwork("setup");
        const baseSha = await cloneRepository(ctx, sandbox, task.step.id, {
          url: cloneUrl,
          ...(input.ref === undefined ? {} : { ref: input.ref }),
        });
        const profile = detectProject(await readProjectFiles(sandbox));
        await task.agent.say(
          `Detected ${profile.ecosystem}${profile.packageManager === null ? "" : ` (${profile.packageManager})`}: test ${profile.commands.test === null ? "none" : `\`${commandLabel(profile.commands.test)}\``}, lint ${profile.commands.lint === null ? "none" : `\`${commandLabel(profile.commands.lint)}\``}, typecheck ${profile.commands.typecheck === null ? "none" : `\`${commandLabel(profile.commands.typecheck)}\``}.`,
        );
        const installed = await install(sandbox, task.step.id, profile);
        const baselineTree = await snapshotTree(sandbox);
        await sandbox.setNetwork("work");
        const info: ShipWorkspace = {
          sandboxKind: sandbox.kind,
          sandboxId: sandbox.id,
          repo,
          ref: input.ref ?? null,
          baseSha,
          baselineTree,
          profile,
          installed: commandSummary(installed),
        };
        const id = await publish(task.step.id, SHIP_WORKSPACE_KIND, `Sandbox for ${repo}`, info);
        return result(`Cloned ${repo} at ${baseSha.slice(0, 7)} and installed dependencies`, [id]);
      } catch (error) {
        return fatalFrom(error);
      }
    },
  };

  const baseline: StepExecutor = {
    id: SHIP_STEP_IDS.baseline,
    role: "analyst",
    modelRole: "fast",
    capabilities: [CAPABILITIES.sandboxExec],
    required: true,
    needs: [SHIP_STEP_IDS.prepare],
    description:
      "Runs the detected test, lint and typecheck commands before any change and records the results.",
    run: async (task) => {
      const sandbox = await workspace(task.step.id);
      const { info } = workspaceInfo();
      const checks = await runChecks(sandbox, task.step.id, "baseline", info.profile);
      const id = await publish(task.step.id, SHIP_TEST_REPORT_KIND, "Baseline tests", checks);
      await task.agent.say(`Baseline tests: ${describeRun(checks.test)}.`);
      return result(`Baseline tests ${describeRun(checks.test)}`, [id]);
    },
  };

  const brief = (info: ShipWorkspace, before: ShipTestReport | undefined): string => {
    const commands = Object.entries(info.profile.commands)
      .filter(([name, command]) => name !== "install" && command !== null)
      .map(([name, command]) => `- ${name}: \`${command === null ? "" : commandLabel(command)}\``);
    return [
      `Repository: ${repo} at ${info.baseSha}`,
      `Improvement (${improvement.kind}, effort ${improvement.effort}): ${improvement.title}`,
      `Rationale: ${improvement.rationale}`,
      "Acceptance criteria:",
      ...improvement.acceptance.map((item) => `- ${item}`),
      improvement.files.length === 0
        ? "Candidate files: none named; explore the repository."
        : `Candidate files: ${improvement.files.join(", ")}`,
      "Commands you can run with the run tool:",
      ...(commands.length === 0 ? ["- none detected (only git_status and git_diff)"] : commands),
      "- git_status, git_diff",
      `Baseline: tests ${before === undefined ? "not run" : describeRun(before.test)}.`,
      ...(before?.test.passed === false && before.testOutput !== ""
        ? [
            "Baseline test output (tail, untrusted):",
            "```",
            cut(before.testOutput.slice(-1_500), 1_500),
            "```",
          ]
        : []),
    ].join("\n");
  };

  const implement: StepExecutor = {
    id: SHIP_STEP_IDS.implement,
    role: "engineer",
    modelRole: "worker",
    capabilities: [CAPABILITIES.sandboxRead, CAPABILITIES.sandboxWrite, CAPABILITIES.sandboxExec],
    required: true,
    needs: [SHIP_STEP_IDS.baseline],
    description:
      "The Engineer: a tool-calling loop with read_file, list_dir, search, write_file (confined to the repository) and run (detected commands only), followed by a runtime-run test check; up to three rounds within iteration, token and wall-time caps.",
    run: async (task) => {
      const { info } = workspaceInfo();
      const recorded = diffArtifact();
      if (recorded !== undefined && recorded.diff.files.length > 0) {
        await workspace(task.step.id);
        return result(`Reused the recorded change (${recorded.diff.stat.files} files)`, [
          recorded.id,
        ]);
      }
      const sandbox = await workspace(task.step.id);
      const before = report(SHIP_STEP_IDS.baseline);
      const written = new Set<string>();
      const tools = createEngineerTools({
        ctx,
        sandbox: () => workspace(task.step.id),
        profile: info.profile,
        onWrite: (path) => written.add(path),
      });
      const deadlineAt = ctx.now().getTime() + limits.engineerMs;
      const testCommand = info.profile.commands.test;
      let messages: ChatMessage[] = [{ role: "user", content: brief(info, before) }];
      let rounds = 0;
      let outcome = "not_started";
      let summary = "";
      while (rounds < limits.rounds) {
        rounds += 1;
        const loop = await runAgentLoop({
          run: ctx,
          step: task.grant,
          agentId: task.agent.agentId,
          role: "worker",
          system: deps.prompts.engineer.body,
          tools,
          messages,
          maxIterations: limits.iterationsPerRound,
          maxTokens: limits.maxTokensPerCall,
          maxToolCalls: limits.toolCallsPerRound,
          temperature: 0.2,
          deadlineAt,
        });
        outcome = loop.outcome;
        messages = loop.messages;
        if (loop.text.trim() !== "") summary = loop.text.trim();
        if (loop.outcome === "aborted") throw new RunAbortedError();
        if (loop.outcome === "no_model" && written.size === 0)
          throw new FatalStepError(
            "no_model_available",
            `No worker model was available for the Engineer. ${loop.detail ?? ""}`.trim(),
          );
        if (written.size === 0 || testCommand === null) break;
        const check = await runInSandbox(ctx, sandbox, {
          stepId: task.step.id,
          purpose: "engineer",
          argv: testCommand.argv,
          timeoutMs: SHIP_TIMEOUTS.testMs,
        });
        if (check.exitCode === 0) {
          outcome = "tests_pass";
          break;
        }
        const stop = ["budget_exceeded", "deadline", "no_model"].includes(loop.outcome);
        if (stop || rounds >= limits.rounds) break;
        await task.agent.say(
          `Round ${rounds}: tests still fail; sending the failure back to the Engineer.`,
        );
        messages.push({
          role: "user",
          content: `The runtime ran \`${commandLabel(testCommand)}\` after your changes and it ${check.timedOut ? "timed out" : `exited with ${check.exitCode ?? "?"}`}. Output tail (untrusted):\n\`\`\`\n${cut(check.output.slice(-limits.feedbackChars), limits.feedbackChars)}\n\`\`\`\nFix the failure, then run the tests again. Do not weaken tests.`,
        });
      }
      let diff;
      try {
        diff = await collectDiff(ctx, sandbox, task.step.id, info.baseSha, info.baselineTree);
      } catch (error) {
        return fatalFrom(error);
      }
      if (diff.files.length === 0)
        throw new FatalStepError(
          "no_changes",
          `The Engineer made no change after ${rounds} round${rounds === 1 ? "" : "s"} (${outcome}).`,
        );
      const content: ShipDiff = {
        ...diff,
        rounds,
        engineerOutcome: cut(outcome, 40),
        summary: cut(summary, 2_000),
      };
      const id = await publish(task.step.id, SHIP_DIFF_KIND, `Diff: ${improvement.title}`, content);
      await task.agent.say(
        `${diff.stat.files} file${diff.stat.files === 1 ? "" : "s"} changed (+${diff.stat.additions} −${diff.stat.deletions}) after ${rounds} round${rounds === 1 ? "" : "s"}.`,
      );
      return result(
        `Changed ${diff.stat.files} files (+${diff.stat.additions} −${diff.stat.deletions}); ${outcome}`,
        [id],
      );
    },
  };

  const verify: StepExecutor = {
    id: SHIP_STEP_IDS.verify,
    role: "critic",
    modelRole: "fast",
    capabilities: [CAPABILITIES.sandboxExec],
    required: true,
    needs: [SHIP_STEP_IDS.implement],
    description:
      "Re-runs the test, lint and typecheck commands on the change and records them next to the baseline.",
    run: async (task) => {
      const sandbox = await workspace(task.step.id);
      const { info } = workspaceInfo();
      const checks = await runChecks(sandbox, task.step.id, "verify", info.profile);
      const id = await publish(
        task.step.id,
        SHIP_TEST_REPORT_KIND,
        "Tests after the change",
        checks,
      );
      await task.agent.say(`Tests after the change: ${describeRun(checks.test)}.`);
      return result(`Tests after the change ${describeRun(checks.test)}`, [id]);
    },
  };

  const decideMode = async (
    after: ShipTestReport,
  ): Promise<{ mode: ShipMode; reason: string; session: RepoSession | null }> => {
    const patch = (reason: string) => ({ mode: "patch" as const, reason, session: null });
    if (ctx.audience !== "owner")
      return patch(
        "Public demo runs never push to GitHub; the change is offered as a patch and test report.",
      );
    if (after.test.passed !== true)
      return patch(
        after.test.command === null
          ? "No test command was detected, so no pull request is offered; the change is offered as a patch."
          : "The repository's tests do not pass after the change, so no pull request is offered.",
      );
    if (deps.github === null)
      return patch("No GitHub App is configured (GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY).");
    try {
      const session = await deps.github.sessionFor(repoRef);
      if (session === null)
        return patch(
          `The Delegate GitHub App is not installed on ${repo}, so the change is offered as a patch.`,
        );
      return {
        mode: "pull_request",
        reason: `Opening a pull request on ${repo} needs your approval.`,
        session,
      };
    } catch (error) {
      return patch(
        `The GitHub App installation could not be checked (${error instanceof GitHubApiError ? `HTTP ${error.status}` : "network error"}), so the change is offered as a patch.`,
      );
    }
  };

  const policyAllowsPr = async (stepId: string, grant: readonly string[]) => {
    const decision = evaluate(ctx.policies, {
      workspaceId: ctx.workspaceId,
      runId,
      stepId,
      actor: SHIP_SYSTEM_ACTOR,
      tool: GITHUB_OPEN_PR_TOOL,
      capability: CAPABILITIES.repoWrite,
      grantedCapabilities: [...grant],
      argsSummary: `pull request on ${repo}`,
      targetDomain: GITHUB_API_HOST,
      dataClassification: ctx.classification,
      estimatedCostMicroUsd: 0,
      spentRunMicroUsd: ctx.budget.spent().microUsd,
      spentDayMicroUsd: 0,
    });
    await emit({
      runId,
      type: "policy.decided",
      stepId,
      payload: {
        tool: GITHUB_OPEN_PR_TOOL,
        decision: decision.decision,
        policyId: decision.policyId,
        reason: cut(decision.reason, 500),
      },
    });
    return decision;
  };

  const awaitDecision = async (
    request: Parameters<AwaitShipApproval>[0],
  ): Promise<ShipDecision> => {
    if (deps.awaitShipApproval === undefined)
      return { decision: "rejected", reason: NO_REVIEWER_REASON };
    const raw = await deps.awaitShipApproval(request, ctx.signal);
    const parsed = ShipDecisionSchema.safeParse(raw);
    return parsed.success
      ? parsed.data
      : { decision: "rejected", reason: "The approval decision was not valid." };
  };

  const ship: StepExecutor = {
    id: SHIP_STEP_IDS.ship,
    role: "editor",
    modelRole: "fast",
    capabilities: [CAPABILITIES.artifactWrite, CAPABILITIES.repoWrite],
    required: true,
    needs: [SHIP_STEP_IDS.verify],
    description:
      "Asks a human to approve the diff with before/after test results; on approval opens a pull request through the GitHub App (owner runs on authorised repositories with passing tests) or publishes the patch and test report.",
    run: async (task) => {
      const recorded = diffArtifact();
      const { info } = workspaceInfo();
      const before = report(SHIP_STEP_IDS.baseline);
      const after = report(SHIP_STEP_IDS.verify);
      if (recorded === undefined || before === undefined || after === undefined)
        throw new FatalStepError("ship_inputs_missing", "The diff or test reports are missing");
      const { diff } = recorded;
      const branch = branchName(improvement, runId);
      let { mode, reason, session } = await decideMode(after);
      if (mode === "pull_request") {
        const decision = await policyAllowsPr(task.step.id, task.grant.capabilities);
        if (decision.decision === "deny") {
          mode = "patch";
          session = null;
          reason = `Policy ${decision.policyId} denies pull requests here: ${cut(decision.reason, 200)}`;
        }
      }
      const base =
        session === null
          ? (input.ref ?? "default branch")
          : input.ref !== undefined && !/^[0-9a-f]{40}$/.test(input.ref)
            ? input.ref
            : await session.defaultBranch().catch(() => "main");
      const approvalId = approvalIdFor(runId);
      const request = {
        approvalId,
        mode,
        repo,
        base,
        branch,
        title: improvement.title,
        diffStat: diff.stat,
        patchArtifactId: recorded.id,
        baseline: before.test,
        after: after.test,
        reason,
      };
      await emit({
        runId,
        type: "ship.approval.requested",
        stepId: task.step.id,
        payload: request,
      });
      await task.agent.say(
        mode === "pull_request"
          ? `Waiting for approval to open a pull request on ${repo}.`
          : `Waiting for approval of the patch. ${reason}`,
      );
      const decision = await awaitDecision(request);
      await emit({
        runId,
        type: "ship.approval.decided",
        stepId: task.step.id,
        payload:
          decision.decision === "approved"
            ? {
                approvalId,
                decision: "approved",
                decidedBy: decision.approvedBy ?? DEFAULT_SHIP_REVIEWER,
              }
            : {
                approvalId,
                decision: "rejected",
                decidedBy: decision.rejectedBy ?? SHIP_SYSTEM_ACTOR,
                ...(decision.reason === undefined ? {} : { reason: cut(decision.reason, 500) }),
              },
      });
      const shared = {
        mode,
        repo,
        base,
        branch,
        title: improvement.title,
        diffStat: diff.stat,
        baseline: before.test,
        after: after.test,
      };
      const patchResult = (why: string): ShipResult => ({
        ...shared,
        status: "patch_ready",
        reason: cut(why, 500),
        patch: { fileName: `${slug(improvement.id, 30)}.patch`, content: diff.patch },
        testReport: cut(
          testReportText({ repo, baseSha: info.baseSha, improvement, baseline: before, after }),
          20_000,
        ),
      });
      if (decision.decision === "rejected") {
        const why = decision.reason ?? "The reviewer rejected the change.";
        const id = await publish(
          task.step.id,
          SHIP_RESULT_KIND,
          `Not shipped: ${improvement.title}`,
          {
            ...shared,
            status: "rejected",
            reason: cut(why, 500),
          } satisfies ShipResult,
        );
        return result(`Not shipped: ${why}`, [id], 0.5);
      }
      if (mode === "patch" || session === null) {
        const id = await publish(
          task.step.id,
          SHIP_RESULT_KIND,
          `Patch: ${improvement.title}`,
          patchResult(reason),
        );
        return result(`Patch and test report ready (${diff.stat.files} files)`, [id]);
      }
      const toolCallId = ctx.nextId("tc");
      await emit({
        runId,
        type: "tool.called",
        stepId: task.step.id,
        payload: {
          toolCallId,
          tool: GITHUB_OPEN_PR_TOOL,
          capability: CAPABILITIES.repoWrite,
          argsSummary: cut(`PR ${branch} → ${base} on ${repo}`, 280),
        },
      });
      const startedAt = ctx.now().getTime();
      try {
        const sandbox = await workspace(task.step.id);
        const files = await fileChanges(sandbox, diff);
        const opened = await session.openPullRequest({
          baseSha: info.baseSha,
          base,
          branch,
          title: improvement.title,
          body: pullRequestBody({ improvement, baseline: before, after, files: diff.files, runId }),
          message: commitMessage(improvement, runId),
          files,
        });
        await emit({
          runId,
          type: "tool.result",
          stepId: task.step.id,
          payload: {
            toolCallId,
            tool: GITHUB_OPEN_PR_TOOL,
            ok: true,
            summary: `Opened pull request #${opened.number} on ${repo}`,
            durationMs: Math.max(0, ctx.now().getTime() - startedAt),
          },
        });
        const pullRequest = {
          url: opened.url,
          number: opened.number,
          repo,
          branch,
          base,
          commitSha: opened.commitSha,
        };
        await emit({ runId, type: "pr.opened", stepId: task.step.id, payload: pullRequest });
        const id = await publish(task.step.id, SHIP_RESULT_KIND, `Pull request #${opened.number}`, {
          ...shared,
          status: "opened",
          reason: "Approved and opened through the GitHub App.",
          pullRequest,
        } satisfies ShipResult);
        return result(`Opened pull request #${opened.number} on ${repo}`, [id]);
      } catch (error) {
        if (error instanceof RunAbortedError) throw error;
        const message =
          error instanceof GitHubApiError || error instanceof WorkspaceError
            ? error.message
            : "The pull request could not be opened";
        await emit({
          runId,
          type: "tool.result",
          stepId: task.step.id,
          payload: {
            toolCallId,
            tool: GITHUB_OPEN_PR_TOOL,
            ok: false,
            summary: `${GITHUB_OPEN_PR_TOOL} failed`,
            durationMs: Math.max(0, ctx.now().getTime() - startedAt),
            error: cut(message, 300),
          },
        });
        const id = await publish(
          task.step.id,
          SHIP_RESULT_KIND,
          `Patch: ${improvement.title}`,
          patchResult(
            `Opening the pull request failed (${cut(message, 200)}); the change is offered as a patch.`,
          ),
        );
        return result("Pull request failed; patch and test report ready", [id], 0.5);
      }
    },
  };

  const executors = [prepare, baseline, implement, verify, ship];
  return {
    planner: {
      missionId: "ship-a-pr",
      title: "Ship-a-PR",
      objective: `Implement "${improvement.title}" in ${repo}, run its tests, and ship the change after approval.`,
      input,
      planningHints: SHIP_PLANNING_HINTS,
      executors,
      allowedCapabilities: [...SHIP_CAPABILITIES],
    },
    defaultPlan: shipPlan(),
    clock,
    fixedPlan:
      "Ship-a-PR runs a fixed, audited chain (prepare, baseline, implement, verify, ship); the planner model is not used.",
    finish: (outcome) => {
      const shipped = latest(SHIP_RESULT_KIND);
      if (shipped === undefined)
        return Promise.resolve({
          status: "failed",
          error: stepFailure(outcome, SHIP_STEP_IDS.ship),
        });
      const final = ShipResultSchema.parse(shipped.content);
      return Promise.resolve({
        status: "completed",
        summary:
          final.status === "opened" && final.pullRequest !== undefined
            ? `Opened ${final.pullRequest.url} for "${final.title}" (${final.diffStat.files} files, tests ${describeRun(final.after)}).`
            : final.status === "patch_ready"
              ? `Patch ready for "${final.title}" (${final.diffStat.files} files, tests ${describeRun(final.after)}). ${final.reason}`
              : `Not shipped: ${final.reason}`,
      });
    },
    close: async () => {
      const sandbox = live;
      live = undefined;
      await sandbox?.close().catch(() => undefined);
    },
  };
}

export async function runShipAPr(deps: ShipAPrDependencies): Promise<"completed" | "failed"> {
  const mission = createShipAPrMission(deps);
  try {
    return await runPlannedMission(deps.ctx, mission, {
      plannerPrompt: deps.prompts.planner,
      ...deps.run,
    });
  } finally {
    await mission.close();
  }
}
