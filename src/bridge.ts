import * as http from 'http';
import type { Agent, TaskInput, TaskOutput, ReviewResult } from './types';

export interface BridgeHandlers {
  delegate: (subtasks: { prompt: string; name?: string }[]) => Promise<string[]>;
  submitReview: (result: ReviewResult) => void;
}

/**
 * Local HTTP server that exposes framework capabilities to any agent process.
 * Agents call these endpoints via curl, fetch, subprocess — any language.
 *
 * Endpoints:
 *   POST /delegate       — spawn sub-agents, returns results
 *   POST /submit-review  — submit review verdict
 *   POST /submit-result  — submit final task output
 *   GET  /task           — get current task info
 *   GET  /health         — health check
 */
export class AgentBridge {
  private server: http.Server | null = null;
  private handlers: BridgeHandlers | null = null;
  private currentTask: TaskInput | null = null;
  private reviewResolve: ((result: ReviewResult) => void) | null = null;
  private resultResolve: ((result: TaskOutput) => void) | null = null;
  readonly port: number;

  constructor(port = 0) {
    this.port = port;
  }

  async start(): Promise<number> {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.listen(this.port, '127.0.0.1', () => {
        const addr = this.server!.address() as { port: number };
        (this as any).port = addr.port;
        resolve(addr.port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });
  }

  setHandlers(handlers: BridgeHandlers) { this.handlers = handlers; }
  setTask(task: TaskInput) { this.currentTask = task; }

  waitForReview(): Promise<ReviewResult> {
    return new Promise((resolve) => { this.reviewResolve = resolve; });
  }

  waitForResult(): Promise<TaskOutput> {
    return new Promise((resolve) => { this.resultResolve = resolve; });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || '';
    const method = req.method || '';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    if (method === 'GET' && url === '/health') {
      this.json(res, 200, { ok: true });
      return;
    }

    if (method === 'GET' && url === '/task') {
      if (!this.currentTask) { this.json(res, 404, { error: 'No active task' }); return; }
      const { delegate, ...safe } = this.currentTask;
      this.json(res, 200, { ...safe, canDelegate: !!delegate });
      return;
    }

    if (method === 'POST' && url === '/delegate') {
      this.readBody(req, async (body) => {
        if (!this.handlers?.delegate) { this.json(res, 400, { error: 'Delegation not available' }); return; }
        try {
          const { subtasks } = body;
          if (!Array.isArray(subtasks)) { this.json(res, 400, { error: 'subtasks must be an array' }); return; }
          const results = await this.handlers.delegate(subtasks);
          this.json(res, 200, { results });
        } catch (err: any) {
          this.json(res, 500, { error: err.message });
        }
      });
      return;
    }

    if (method === 'POST' && url === '/submit-review') {
      this.readBody(req, (body) => {
        if (!this.reviewResolve) { this.json(res, 400, { error: 'No review pending' }); return; }
        const result: ReviewResult = {
          approved: !!body.approved,
          confidence: typeof body.confidence === 'number' ? body.confidence : 0.5,
          feedback: body.feedback || '',
        };
        this.reviewResolve(result);
        this.reviewResolve = null;
        this.json(res, 200, { ok: true });
      });
      return;
    }

    if (method === 'POST' && url === '/submit-result') {
      this.readBody(req, (body) => {
        if (!this.resultResolve) { this.json(res, 400, { error: 'No result pending' }); return; }
        const result: TaskOutput = {
          status: body.status || 'completed',
          output: body.output || '',
          artifacts: body.artifacts,
          usage: body.usage,
          error: body.error,
        };
        this.resultResolve(result);
        this.resultResolve = null;
        this.json(res, 200, { ok: true });
      });
      return;
    }

    this.json(res, 404, { error: 'Not found' });
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private readBody(req: http.IncomingMessage, cb: (body: any) => void) {
    let data = '';
    req.on('data', (chunk) => data += chunk);
    req.on('end', () => {
      try { cb(JSON.parse(data)); }
      catch { cb({}); }
    });
  }
}

/**
 * Wraps any external process as an Agent by exposing the bridge server.
 *
 * Two modes:
 * - **return mode**: `run` returns a string → used as output (simple scripts)
 * - **bridge mode**: `run` returns void, agent POSTs to /submit-result (any process)
 *
 * The agent process receives env vars:
 *   ROBAL_BRIDGE_URL    — base URL of the bridge server
 *   ROBAL_TASK_URL      — GET to read current task
 *   ROBAL_DELEGATE_URL  — POST to delegate subtasks
 *   ROBAL_RESULT_URL    — POST to submit final result
 *   ROBAL_PROMPT        — the task prompt
 *   ROBAL_CAN_DELEGATE  — "true" or "false"
 *   ROBAL_DEPTH         — current depth in hierarchy
 *   ROBAL_FEEDBACK      — reviewer feedback (if retrying)
 *
 * @example
 * ```ts
 * // Any CLI tool — it reads env vars and POSTs result back
 * const { agent, bridge } = await createBridgedAgent({
 *   run: async (task, env) => {
 *     execSync(`my-agent-cli`, { env: { ...process.env, ...env } });
 *     // Agent POSTs to ROBAL_RESULT_URL when done — no return needed
 *   },
 * });
 * ```
 */
export async function createBridgedAgent(opts: {
  run: (task: TaskInput, env: Record<string, string>) => Promise<string | void>;
  port?: number;
  /** Timeout waiting for agent to submit result (ms). Default 300000 (5 min). */
  timeoutMs?: number;
}): Promise<{ agent: Agent; bridge: AgentBridge }> {
  const bridge = new AgentBridge(opts.port || 0);
  const port = await bridge.start();
  const baseUrl = `http://127.0.0.1:${port}`;
  const timeout = opts.timeoutMs ?? 300_000;

  const agent: Agent = {
    async execute(task) {
      bridge.setTask(task);
      bridge.setHandlers({
        delegate: task.delegate || (async () => { throw new Error('Delegation not available at this depth'); }),
        submitReview: () => {},
      });

      const env: Record<string, string> = {
        ROBAL_BRIDGE_URL: baseUrl,
        ROBAL_TASK_URL: `${baseUrl}/task`,
        ROBAL_DELEGATE_URL: `${baseUrl}/delegate`,
        ROBAL_RESULT_URL: `${baseUrl}/submit-result`,
        ROBAL_TASK_ID: task.id,
        ROBAL_TEAM_ID: task.teamId,
        ROBAL_PROMPT: task.prompt,
        ROBAL_CAN_DELEGATE: task.delegate ? 'true' : 'false',
        ROBAL_DEPTH: String(task.depth ?? 0),
        ...(task.feedback ? { ROBAL_FEEDBACK: task.feedback } : {}),
      };

      try {
        const resultPromise = bridge.waitForResult();
        const runResult = await opts.run(task, env);

        // If run() returned a string, use it directly (return mode)
        if (typeof runResult === 'string') {
          return { status: 'completed', output: runResult };
        }

        // Otherwise wait for agent to POST to /submit-result (bridge mode)
        const timer = setTimeout(() => {
          // Resolve with timeout error if agent never posts
          (bridge as any).resultResolve?.({ status: 'failed', output: '', error: `Agent did not submit result within ${timeout}ms` });
        }, timeout);

        const result = await resultPromise;
        clearTimeout(timer);
        return result;
      } catch (err: any) {
        return { status: 'failed', output: '', error: err.message };
      }
    },
  };

  return { agent, bridge };
}

/**
 * Creates a Reviewer that waits for an external process to POST to /submit-review.
 */
export function createBridgedReviewer(bridge: AgentBridge): {
  reviewer: import('./types').Reviewer;
} {
  return {
    reviewer: {
      async review(task, output) {
        bridge.setTask({ ...task, prompt: `Review: ${task.prompt}\n\nOutput: ${output.output}` });
        return bridge.waitForReview();
      },
    },
  };
}
