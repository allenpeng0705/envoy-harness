/**
 * Gap 8 — model-facing team board tools.
 */

import { z } from "zod";

import type { ModelAdapter } from "../model.js";
import type { Tool, ToolResult } from "../tools/types.js";
import type { TeamJobRegistry } from "../protocol/team-job-board.js";
import { Team } from "./runner.js";
import type { TeamConfig } from "./types.js";
import { parseTeamToml } from "./toml.js";

export interface MakeTeamToolsOptions {
  registry: TeamJobRegistry;
  getModel: () => ModelAdapter;
  getCwd: () => string;
}

function asTeamConfig(raw: unknown): TeamConfig {
  if (typeof raw === "string") {
    return parseTeamToml(raw);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("team config must be a TOML string or JSON object");
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string" || !Array.isArray(o.agents)) {
    throw new Error("team config requires name and agents[]");
  }
  return {
    name: o.name,
    agents: o.agents.map((a, i) => {
      const row = a as Record<string, unknown>;
      if (typeof row.id !== "string" || typeof row.objective !== "string") {
        throw new Error(`agents[${i}] requires id and objective`);
      }
      return {
        id: row.id,
        role: typeof row.role === "string" ? row.role : row.id,
        objective: row.objective,
        dependsOn: Array.isArray(row.dependsOn)
          ? row.dependsOn.filter((d): d is string => typeof d === "string")
          : [],
        ...(typeof row.systemPrompt === "string"
          ? { systemPrompt: row.systemPrompt }
          : {}),
        ...(typeof row.host === "string" ? { host: row.host } : {}),
      };
    }),
  };
}

export function makeTeamTools(options: MakeTeamToolsOptions): Tool[] {
  const { registry, getModel, getCwd } = options;

  const teamStart: Tool = {
    name: "team_start",
    description:
      "Start a local multi-agent team (DAG). Pass `config` as JSON " +
      "{name, agents:[{id,role,objective,dependsOn}]} or a TOML string. " +
      "Updates the shared team job board.",
    parameters: z.object({
      config: z.union([z.string(), z.record(z.unknown())]),
      input: z
        .string()
        .optional()
        .describe("Substituted for ${input} in objectives"),
    }),
    async execute(args): Promise<ToolResult> {
      let config: TeamConfig;
      try {
        config = asTeamConfig(args.config);
      } catch (err) {
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
      const jobId = registry.startTeamJob({
        teamName: config.name,
        agents: config.agents.map((a) => ({
          id: a.id,
          host: a.host ?? "local",
        })),
      });
      try {
        const team = new Team({
          config,
          model: getModel(),
          cwd: getCwd(),
          ...(args.input !== undefined ? { input: args.input } : {}),
          onAgentStart: ({ spec }) => {
            registry.setAgentStatus(jobId, spec.id, {
              status: "running",
              startedAt: new Date().toISOString(),
            });
          },
          onAgentFinish: ({ spec, result }) => {
            registry.setAgentStatus(jobId, spec.id, {
              status:
                result.stopReason === "end_turn" ? "completed" : "failed",
              completedAt: new Date().toISOString(),
            });
          },
        });
        const result = await team.runOnce();
        registry.finishTeamJob(
          jobId,
          result.status === "completed" ? "completed" : "failed",
        );
        return {
          content: JSON.stringify({
            job_id: jobId,
            team: config.name,
            status: result.status,
            agents: result.agents.map((a) => ({
              id: a.id,
              text: a.finalText.slice(0, 2000),
              stop_reason: a.stopReason,
            })),
            ...(result.error !== undefined ? { error: result.error } : {}),
          }),
        };
      } catch (err) {
        registry.finishTeamJob(jobId, "failed");
        return {
          content: err instanceof Error ? err.message : String(err),
          isError: true,
        };
      }
    },
  };

  const teamJobs: Tool = {
    name: "team_jobs",
    description: "List jobs on the shared team job board.",
    parameters: z.object({}),
    isConcurrencySafe: () => true,
    async execute(): Promise<ToolResult> {
      return {
        content: JSON.stringify({ jobs: registry.list() }),
      };
    },
  };

  const teamStatus: Tool = {
    name: "team_status",
    description: "Get one team job by id from the shared board.",
    parameters: z.object({
      job_id: z.string().min(1),
    }),
    isConcurrencySafe: () => true,
    async execute(args): Promise<ToolResult> {
      const job = registry.list().find((j) => j.jobId === args.job_id);
      if (job === undefined) {
        return {
          content: `unknown team job '${args.job_id}'`,
          isError: true,
        };
      }
      return { content: JSON.stringify(job) };
    },
  };

  return [teamStart, teamJobs, teamStatus];
}
