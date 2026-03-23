import type { OrchestratorConfig, OrchestratorEvent, TaskOutput, TaskInput } from './types';
import { Team } from './team';

/**
 * Orchestrator — coordinates multiple teams with different agents.
 *
 * @example
 * ```ts
 * const orc = new Orchestrator({
 *   teams: {
 *     research: { agent: researchAgent },
 *     writer:   { agent: writerAgent, reviewer: editorAgent },
 *   },
 *   channels: [
 *     { from: 'research', to: 'writer' },
 *   ],
 * });
 *
 * // Run a single team
 * const result = await orc.run('research', 'Find market trends for AI agents');
 *
 * // Run a pipeline (research → writer, connected by channel)
 * const final = await orc.pipeline('research', 'Write a report on AI agent market');
 * ```
 */
export class Orchestrator {
  private teams: Map<string, Team> = new Map();
  private channels: OrchestratorConfig['channels'];
  private emit: (event: OrchestratorEvent) => void;

  constructor(config: OrchestratorConfig) {
    this.emit = config.onEvent || (() => {});
    this.channels = config.channels || [];

    for (const [id, teamConfig] of Object.entries(config.teams)) {
      this.teams.set(id, new Team(id, teamConfig, this.emit));
    }
  }

  /** Get a team by ID. */
  team(id: string): Team {
    const t = this.teams.get(id);
    if (!t) throw new Error(`Team '${id}' not found. Available: ${[...this.teams.keys()].join(', ')}`);
    return t;
  }

  /** Run a task on a specific team. */
  async run(teamId: string, prompt: string, context?: TaskInput['context']): Promise<TaskOutput> {
    return this.team(teamId).run(prompt, context);
  }

  /**
   * Run a pipeline starting from a team.
   * Output flows through channels to downstream teams.
   * Channels with gates hold output until the gate approves.
   */
  async pipeline(startTeamId: string, prompt: string, context?: TaskInput['context']): Promise<TaskOutput> {
    let currentOutput = await this.run(startTeamId, prompt, context);
    if (currentOutput.status === 'failed') return currentOutput;

    const visited = new Set<string>([startTeamId]);
    let currentTeamId = startTeamId;

    while (true) {
      const outgoing = (this.channels || []).filter(c => c.from === currentTeamId && !visited.has(c.to));
      if (outgoing.length === 0) break;

      if (outgoing.length === 1) {
        // Linear chain
        const channel = outgoing[0];
        const routed = await this.routeThrough(channel, currentOutput.output, context);
        if (!routed) break;
        currentOutput = routed.output;
        currentTeamId = channel.to;
        visited.add(currentTeamId);
        if (currentOutput.status === 'failed') break;
      } else {
        // Fan-out: run downstream teams in parallel
        const results = await Promise.allSettled(
          outgoing.map(channel => this.routeThrough(channel, currentOutput.output, context))
        );

        const outputs: string[] = [];
        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          visited.add(outgoing[i].to);
          if (r.status === 'fulfilled' && r.value) {
            outputs.push(`[${outgoing[i].to}]: ${r.value.output.output}`);
          } else {
            outputs.push(`[${outgoing[i].to}]: Error`);
          }
        }

        currentOutput = { status: 'completed', output: outputs.join('\n\n---\n\n') };
        break; // Fan-out is a terminal step
      }
    }

    return currentOutput;
  }

  /**
   * Run multiple teams in parallel on different prompts.
   * Useful for fan-out patterns.
   */
  async parallel(tasks: { teamId: string; prompt: string; context?: TaskInput['context'] }[]): Promise<TaskOutput[]> {
    const results = await Promise.allSettled(
      tasks.map(t => this.run(t.teamId, t.prompt, t.context))
    );
    return results.map(r =>
      r.status === 'fulfilled' ? r.value : { status: 'failed' as const, output: '', error: r.reason?.message }
    );
  }

  private async routeThrough(
    channel: NonNullable<OrchestratorConfig['channels']>[number],
    output: string,
    context?: TaskInput['context'],
  ): Promise<{ output: TaskOutput } | null> {
    // Gate check
    if (channel.gate) {
      const allowed = await channel.gate(output);
      if (!allowed) {
        this.emit({ type: 'channel:gated', from: channel.from, to: channel.to, taskId: '' });
        return null;
      }
    }

    // Transform
    const transformed = channel.transform ? channel.transform(output) : output;

    this.emit({ type: 'channel:routed', from: channel.from, to: channel.to, taskId: '' });

    const nextContext: TaskInput['context'] = {
      ...context,
      previousOutputs: [...(context?.previousOutputs || []), output],
    };

    const result = await this.team(channel.to).run(transformed, nextContext);
    return { output: result };
  }
}
