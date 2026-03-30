/**
 * Run Executor Service — Phase 2
 *
 * Orchestrates the AI agent pipeline for a given run:
 * 1. Load run + architecture version + agent configs
 * 2. Resolve pipeline (from agentConfigs or default)
 * 3. For each enabled agent: create step, execute, persist artifacts, create deps, complete step
 * 4. Mark run completed (or failed)
 * 5. Return enriched run object
 *
 * GitHub write: NOT active — side-effect free.
 */

import { runsRepository } from "../repositories/runs.repository";
import { architecturesRepository } from "../repositories/architectures.repository";
import { getAgent, DEFAULT_PIPELINE } from "../lib/agents/registry.ts";
import { NotFoundError, ConflictError, ValidationError } from "../lib/errors.ts";
import type { RunContext } from "../lib/agents/types.ts";
import type { AiArtifact, AiStep } from "@shared/schema";

export interface ExecuteRunResult {
  runId: string;
  organizationId: string;
  status: "completed" | "failed";
  stepsExecuted: number;
  artifactsCreated: number;
  error?: string;
}

export const runExecutorService = {
  async executeRun(runId: string, organizationId: string): Promise<ExecuteRunResult> {
    // ── Load run ────────────────────────────────────────────────────────────
    const run = await runsRepository.getById(runId, organizationId);
    if (!run) throw new NotFoundError("Run not found.");

    if (run.status === "running") {
      throw new ConflictError("CONFLICT", "This run is already in progress.");
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      throw new ValidationError("VALIDATION_ERROR", `Run has already finished with status: ${run.status}`);
    }

    // ── Mark run as running ─────────────────────────────────────────────────
    await runsRepository.updateStatus(runId, organizationId, "running");

    try {
      // ── Resolve pipeline ────────────────────────────────────────────────────
      let pipeline: Array<{ agentKey: string; executionOrder: number }>;

      const agentConfigs = await architecturesRepository.listAgentConfigs(run.architectureVersionId);
      const enabledConfigs = agentConfigs
        .filter((c) => c.isEnabled)
        .sort((a, b) => (a.executionOrder ?? 0) - (b.executionOrder ?? 0));

      if (enabledConfigs.length > 0) {
        pipeline = enabledConfigs.map((c) => ({
          agentKey: c.agentKey,
          executionOrder: c.executionOrder ?? 0,
        }));
      } else {
        pipeline = DEFAULT_PIPELINE;
      }

      // ── Run context (builds up as artifacts are produced) ───────────────────
      const accumulatedArtifacts: AiArtifact[] = [];
      const accumulatedSteps: AiStep[] = [];
      let stepsExecuted = 0;
      let artifactsCreated = 0;

      // ── Execute each agent ──────────────────────────────────────────────────
      for (const { agentKey } of pipeline) {
        const agent = getAgent(agentKey);
        if (!agent) {
          // Unknown agent key — skip with a warning step
          const warnStep = await runsRepository.appendStep({
            runId,
            stepKey: agentKey,
            agentKey,
            title: `Unknown agent: ${agentKey}`,
            status: "skipped",
            output: { warning: `Agent "${agentKey}" is not registered in the registry` },
          });
          accumulatedSteps.push(warnStep);
          continue;
        }

        // Create step — status: pending → running
        const step = await runsRepository.appendStep({
          runId,
          stepKey: agentKey,
          agentKey,
          title: agent.title,
          description: agent.description,
          status: "running",
          startedAt: new Date(),
        });
        accumulatedSteps.push(step);

        const ctx: RunContext = {
          runId,
          organizationId,
          projectId: run.projectId,
          architectureProfileId: run.architectureProfileId,
          architectureVersionId: run.architectureVersionId,
          goal: run.goal ?? "",
          title: run.title ?? null,
          tags: run.tags ?? null,
          pipelineVersion: run.pipelineVersion ?? null,
          previousArtifacts: [...accumulatedArtifacts],
          previousSteps: [...accumulatedSteps],
        };

        let agentOutput;
        try {
          agentOutput = await agent.execute(ctx);
        } catch (agentError) {
          // Agent failed — mark step failed, continue to next (non-blocking)
          await runsRepository.updateStep(step.id, {
            status: "failed",
            completedAt: new Date(),
            error: agentError instanceof Error ? agentError.message : String(agentError),
          });
          // Update step in accumulated list
          accumulatedSteps[accumulatedSteps.length - 1] = {
            ...step,
            status: "failed",
          };
          stepsExecuted++;
          continue;
        }

        // Persist artifacts
        const stepArtifacts: AiArtifact[] = [];
        for (const artifactDef of agentOutput.artifacts) {
          const artifact = await runsRepository.appendArtifact({
            runId,
            stepId: step.id,
            artifactType: artifactDef.artifactType,
            title: artifactDef.title,
            description: artifactDef.description,
            content: artifactDef.content,
            path: artifactDef.path,
            version: artifactDef.version,
            tags: artifactDef.tags,
            metadata: artifactDef.metadata,
          });
          stepArtifacts.push(artifact);
          accumulatedArtifacts.push(artifact);
          artifactsCreated++;
        }

        // Create artifact dependencies (each new artifact depends on all prior artifacts)
        if (accumulatedArtifacts.length > stepArtifacts.length && stepArtifacts.length > 0) {
          const priorArtifacts = accumulatedArtifacts.slice(0, accumulatedArtifacts.length - stepArtifacts.length);
          for (const newArtifact of stepArtifacts) {
            for (const priorArtifact of priorArtifacts) {
              await runsRepository.createArtifactDependency({
                organizationId,
                fromArtifactId: newArtifact.id,
                toArtifactId: priorArtifact.id,
                dependencyType: "uses",
              });
            }
          }
        }

        // Complete step
        const completedStep = await runsRepository.updateStep(step.id, {
          status: "completed",
          completedAt: new Date(),
          output: agentOutput.summary,
        });
        if (completedStep) {
          accumulatedSteps[accumulatedSteps.length - 1] = completedStep;
        }
        stepsExecuted++;
      }

      // ── Mark run completed ──────────────────────────────────────────────────
      await runsRepository.updateStatus(runId, organizationId, "completed");

      return {
        runId,
        organizationId,
        status: "completed",
        stepsExecuted,
        artifactsCreated,
      };
    } catch (err) {
      // Fatal orchestration error — mark run failed
      await runsRepository.updateStatus(runId, organizationId, "failed");
      const message = err instanceof Error ? err.message : String(err);
      return {
        runId,
        organizationId,
        status: "failed",
        stepsExecuted: 0,
        artifactsCreated: 0,
        error: message,
      };
    }
  },
};
