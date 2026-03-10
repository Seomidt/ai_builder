/**
 * GitHub commit and tag formatting for AI Builder Platform.
 *
 * This module defines the canonical formats for commit messages and git tags
 * produced by the AI run pipeline. It is intentionally read-only — GitHub
 * file writing is NOT activated yet. These utilities will be called by the
 * GitHub write pipeline when it is enabled in Phase 2.
 *
 * Commit title format:
 *   [AI RUN {run_number}] {run_title}
 *
 * Commit body format:
 *   Architecture: {architecture_name}
 *   Version: {version_number} — {version_label}
 *   Run ID: {run_id}
 *   Steps: {step_titles}
 *   Tags: {tags}
 *
 * Tag formats:
 *   ai-run-v{run_number}
 *   architecture-{architecture_slug}-v{version_number}
 */

export interface CommitContext {
  run: {
    id: string;
    runNumber: number;
    title: string | null;
    goal: string | null;
    tags: string[] | null;
    pipelineVersion: string | null;
  };
  architecture: {
    name: string;
    slug: string;
  };
  version: {
    versionNumber: string;
    versionLabel: string | null;
    changelog: string | null;
  };
  steps: Array<{
    stepKey: string;
    title: string | null;
    status: string;
  }>;
}

/**
 * Builds the one-line commit title for a run.
 *
 * Example: "[AI RUN 7] Implement auth module"
 */
export function buildCommitTitle(ctx: CommitContext): string {
  const title = ctx.run.title ?? ctx.run.goal ?? "Untitled run";
  return `[AI RUN ${ctx.run.runNumber}] ${title}`;
}

/**
 * Builds the multi-line commit body for a run.
 */
export function buildCommitBody(ctx: CommitContext): string {
  const lines: string[] = [];

  lines.push(`Architecture: ${ctx.architecture.name}`);

  const versionLabel = ctx.version.versionLabel
    ? `${ctx.version.versionNumber} — ${ctx.version.versionLabel}`
    : ctx.version.versionNumber;
  lines.push(`Version: ${versionLabel}`);

  lines.push(`Run ID: ${ctx.run.id}`);

  if (ctx.run.pipelineVersion) {
    lines.push(`Pipeline: ${ctx.run.pipelineVersion}`);
  }

  if (ctx.steps.length > 0) {
    const stepList = ctx.steps
      .map((s) => `  - ${s.title ?? s.stepKey} (${s.status})`)
      .join("\n");
    lines.push(`Steps:\n${stepList}`);
  }

  if (ctx.run.tags && ctx.run.tags.length > 0) {
    lines.push(`Tags: ${ctx.run.tags.join(", ")}`);
  }

  if (ctx.version.changelog) {
    lines.push(`\nChangelog:\n${ctx.version.changelog}`);
  }

  return lines.join("\n");
}

/**
 * Builds the full commit message (title + blank line + body).
 */
export function buildCommitMessage(ctx: CommitContext): string {
  return `${buildCommitTitle(ctx)}\n\n${buildCommitBody(ctx)}`;
}

/**
 * Returns the git tags to apply after a run completes.
 *
 * Tag format:
 *   ai-run-v{run_number}
 *   architecture-{architecture_slug}-v{version_number}
 */
export function buildRunTags(ctx: CommitContext): string[] {
  return [
    `ai-run-v${ctx.run.runNumber}`,
    `architecture-${ctx.architecture.slug}-v${ctx.version.versionNumber}`,
  ];
}

/**
 * Returns the branch name to create for a run.
 *
 * Branch format:
 *   ai-run/{run_number}/{slugified_title}
 */
export function buildBranchName(ctx: CommitContext): string {
  const titleSlug = (ctx.run.title ?? ctx.run.goal ?? "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 40);
  return `ai-run/${ctx.run.runNumber}/${titleSlug}`;
}

/**
 * Renders a preview of what the commit will look like when GitHub integration
 * is activated. Safe to call from the API layer for display purposes.
 */
export function previewCommit(ctx: CommitContext): {
  title: string;
  body: string;
  fullMessage: string;
  branch: string;
  tags: string[];
} {
  return {
    title: buildCommitTitle(ctx),
    body: buildCommitBody(ctx),
    fullMessage: buildCommitMessage(ctx),
    branch: buildBranchName(ctx),
    tags: buildRunTags(ctx),
  };
}
