import * as http from 'http';
import type { Agent, TaskInput, ReviewResult } from './types';

export interface BridgeHandlers {
  delegate: (subtasks: { prompt: string; name?: string }[]) => Promise<string[]>;
  submitReview: (result: ReviewResult) => void;
}

/**
 * Local HTTP server that exposes framework capabilities to any agent process.
 * Agents call these endpoints via curl, fetch, subprocess — any language.
 *
 * Endpoints:
 *   POST /delegate     — spawn sub-agents, returns results
 *   POST /submit-review — submit review verdict
 *   GET  /task          — get current task info
 *   GET  /health        — health check
 */
export class AgentBridge {
  private server: http.Server | null = null;
  private handlers: BridgeHandlers | null = null;
  private currentTask: TaskInput | null = null;
  private reviewResolve: ((result: ReviewResult) => void) | null = null;
  readonly port: number;

  constructor(port = 0) {
    this.port = port;
  }

  /** Start the bridge server. Returns the actual port (useful when port=0). */
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

  /** Set the delegate handler for the current execution context. */
  setHandlers(handlers: BridgeHandlers) { this.handlers = handlers; }

  /** Set the current task so agents can read it via GET /task. */
  setTask(task: TaskInput) { this.currentTask = task; }

  /** Wait for a review submission from the agent. */
  waitForReview(): Promise<ReviewResult> {
    return new Promise((resolve) => { this.reviewResolve = resolve; });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = req.url || '';
    const method = req.method || '';

    // CORS for any local caller
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
      // Strip the delegate function — can't serialize it
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
 * The external process reads the task from ROBAL_TASK_URL and calls
 * ROBAL_DELEGATE_URL / ROBAL_REVIEW_URL to interact with the framework.
 *
 * @example
 * ```ts
 * const agent = await createBridgedAgent({
 *   run: async (task, env) => {
 *     // env contains ROBAL_BRIDGE_URL, ROBAL_TASK_URL, etc.
 *     execSync(`python my_agent.py`, { env: { ...process.env, ...env } });
 *   },
 * });
 * ```
 */
export async function createBridgedAgent(opts: {
  run: (task: TaskInput, env: Record<string, string>) => Promise<string>;
  port?: number;
}): Promise<{ agent: Agent; bridge: AgentBridge }> {
  const bridge = new AgentBridge(opts.port || 0);
  const port = await bridge.start();
  const baseUrl = `http://127.0.0.1:${port}`;

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
        ROBAL_TASK_ID: task.id,
        ROBAL_TEAM_ID: task.teamId,
        ROBAL_PROMPT: task.prompt,
        ROBAL_CAN_DELEGATE: task.delegate ? 'true' : 'false',
        ROBAL_DEPTH: String(task.depth ?? 0),
        ...(task.feedback ? { ROBAL_FEEDBACK: task.feedback } : {}),
      };

      try {
        const output = await opts.run(task, env);
        return { status: 'completed', output };
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
