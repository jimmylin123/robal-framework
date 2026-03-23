import type { TaskOutput } from './types';
import { AgentServer } from './server';
import { Worker } from './worker';
import type { Agent, TaskInput } from './types';
import { spawn } from 'child_process';

/** An agent available for delegation — name is how the root agent refers to it, agent is the command to start it */
export interface AgentOption {
  /** Human-readable name the root agent uses to delegate, e.g. "code-agent" */
  name: string;
  /** Description of what this agent does */
  description: string;
  /** Shell command to start this agent. Framework pipes instructions to stdin. */
  agent: string;
}

export interface CreateAgentTeamOptions {
  /** Shell command for the root agent, e.g. 'kiro-cli chat --no-interactive --trust-all-tools' */
  rootAgent: string;
  /** The task prompt */
  prompt: string;
  /** Agents available for delegation */
  availableAgents?: AgentOption[];
  /** Max delegation depth (default 3) */
  maxDepth?: number;
  /** Max parallel workers per delegation (default 5) */
  maxWorkers?: number;
  /** Max review-retry cycles (default 3) */
  maxCycles?: number;
  /** Timeout per agent invocation in ms (default 120000) */
  timeoutMs?: number;
  /** Optional reviewer command — if provided, reviews each output */
  reviewer?: string;
  /** Event listener */
  onEvent?: (event: { type: string; [key: string]: any }) => void;
}

/**
 * Create and run an agent team.
 *
 * @example
 * ```ts
 * const result = await createAgentTeam({
 *   rootAgent: 'kiro-cli chat --no-interactive --trust-all-tools',
 *   prompt: 'Build a landing page for our product',
 *   availableAgents: [
 *     { name: 'code-agent', description: 'Writes code', agent: 'kiro-cli chat --no-interactive --trust-all-tools' },
 *     { name: 'design-agent', description: 'Creates designs', agent: 'dalle-cli generate' },
 *   ],
 * });
 * console.log(result.output);
 * ```
 */
export async function createAgentTeam(opts: CreateAgentTeamOptions): Promise<TaskOutput> {
  const timeout = opts.timeoutMs ?? 120_000;
  const servers: AgentServer[] = [];

  // Build agent lookup: name → command
  const agentCommands = new Map<string, string>();
  const agentDescriptions: { name: string; description: string }[] = [];
  for (const a of opts.availableAgents || []) {
    agentCommands.set(a.name, a.agent);
    agentDescriptions.push({ name: a.name, description: a.description });
  }

  // Create an Agent from a shell command
  function makeAgent(command: string): { agent: Agent; server: AgentServer } {
    const server = new AgentServer(0);
    servers.push(server);
    let started = false;

    const agent: Agent = {
      async execute(task) {
        if (!started) { await server.start(); started = true; }
        const port = server.port;
        const baseUrl = `http://127.0.0.1:${port}`;

        server.setTask(task);
        server.setHandlers({
          delegate: task.delegate || (async () => { throw new Error('Delegation not available'); }),
          submitReview: () => {},
        });

        const canDelegate = !!task.delegate;
        const instructions = buildInstructions(baseUrl, canDelegate, task, agentDescriptions);

        const env: Record<string, string> = {
          ROBAL_BRIDGE_URL: baseUrl,
          ROBAL_TASK_URL: `${baseUrl}/task`,
          ROBAL_DELEGATE_URL: `${baseUrl}/delegate`,
          ROBAL_RESULT_URL: `${baseUrl}/submit-result`,
          ROBAL_TASK_ID: task.id,
          ROBAL_TEAM_ID: task.teamId,
          ROBAL_PROMPT: task.prompt,
          ROBAL_CAN_DELEGATE: canDelegate ? 'true' : 'false',
          ROBAL_DEPTH: String(task.depth ?? 0),
          ROBAL_INSTRUCTIONS: instructions,
          ...(task.feedback ? { ROBAL_FEEDBACK: task.feedback } : {}),
        };

        try {
          const resultPromise = server.waitForResult();

          await new Promise<void>((resolve, reject) => {
            const child = spawn('bash', ['-c', command], { env: { ...process.env, ...env }, timeout });
            child.stdin.write(instructions);
            child.stdin.end();
            child.stdout.on('data', () => {});
            child.stderr.on('data', () => {});
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Agent exited with code ${code}`)));
            child.on('error', reject);
          });

          const timer = setTimeout(() => {
            (server as any).resultResolve?.({ status: 'failed', output: '', error: 'Agent did not submit result' });
          }, timeout);
          const result = await resultPromise;
          clearTimeout(timer);
          return result;
        } catch (err: any) {
          return { status: 'failed', output: '', error: err.message };
        }
      },
    };

    return { agent, server };
  }

  // Root agent
  const { agent: rootAgent } = makeAgent(opts.rootAgent);

  // Wrap to resolve child agent names to commands
  const wrappedRoot: Agent = {
    async execute(task) {
      const origDelegate = task.delegate;
      if (origDelegate) {
        task = {
          ...task,
          delegate: (subtasks) => {
            const resolved = subtasks.map(sub => {
              const cmd = sub.name ? agentCommands.get(sub.name) : undefined;
              if (cmd) {
                const { agent: childAgent } = makeAgent(cmd);
                return { ...sub, agent: childAgent };
              }
              // No matching agent name — use root agent
              return sub;
            });
            return origDelegate(resolved);
          },
        };
      }
      return rootAgent.execute(task);
    },
  };

  // Optional reviewer
  let reviewer: import('./types').Reviewer | undefined;
  if (opts.reviewer) {
    const { agent: reviewerAgent } = makeAgent(opts.reviewer);
    reviewer = {
      async review(task, output) {
        const reviewTask: TaskInput = {
          ...task,
          prompt: `Review this work.\n\nOriginal task: ${task.prompt}\n\nOutput to review:\n${output.output}\n\nSubmit your review verdict.`,
        };
        const result = await reviewerAgent.execute(reviewTask);
        // Parse reviewer output as approval
        const lower = result.output.toLowerCase();
        const approved = lower.includes('approved') || lower.includes('approve') || lower.includes('pass');
        return { approved, confidence: approved ? 0.8 : 0.3, feedback: result.output };
      },
    };
  }

  try {
    const worker = new Worker({
      agent: wrappedRoot,
      reviewer,
      maxDepth: opts.maxDepth ?? 3,
      maxWorkers: opts.maxWorkers ?? 5,
      maxCycles: opts.maxCycles ?? 3,
      timeoutMs: timeout,
      onEvent: opts.onEvent ? (e) => opts.onEvent!({ type: 'worker', ...e }) : undefined,
    });

    return await worker.run({ id: `team-${Date.now()}`, prompt: opts.prompt, teamId: 'root' });
  } finally {
    for (const s of servers) await s.stop().catch(() => {});
  }
}

// Re-use buildInstructions from server.ts — import it
import { buildInstructions } from './server';
