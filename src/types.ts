// ── Agent Contract ──
// This is the ONLY interface users implement to plug their agent in.

/**
 * The core agent interface. Implement this to plug any AI agent into robal.
 *
 * An agent receives a task and returns a result. That's it.
 * The framework handles orchestration, delegation, review cycles, and coordination.
 *
 * @example
 * ```ts
 * const myAgent: Agent = {
 *   async execute(task) {
 *     const result = await callOpenAI(task.prompt);
 *     return { status: 'completed', output: result };
 *   }
 * };
 * ```
 */
export interface Agent {
  /** Execute a task and return a result. */
  execute(task: TaskInput): Promise<TaskOutput>;
}

/**
 * Optional: a reviewer that evaluates agent output.
 * If not provided, the framework auto-approves all output.
 *
 * @example
 * ```ts
 * const reviewer: Reviewer = {
 *   async review(task, output) {
 *     const score = await llmJudge(task.prompt, output.output);
 *     return { approved: score > 0.8, confidence: score, feedback: 'Needs more detail' };
 *   }
 * };
 * ```
 */
export interface Reviewer {
  /** Review an agent's output. Return approval or feedback for retry. */
  review(task: TaskInput, output: TaskOutput): Promise<ReviewResult>;
}

// ── Task I/O ──

export interface TaskInput {
  /** Unique task ID */
  id: string;
  /** The goal / instruction for the agent */
  prompt: string;
  /** Which team this task belongs to */
  teamId: string;
  /** Additional context from previous steps, parent tasks, or knowledge */
  context?: TaskContext;
  /** Constraints the agent should respect */
  constraints?: TaskConstraints;
  /** Feedback from a previous review cycle (retry) */
  feedback?: string;
  /** Output from the previous attempt (so the agent can iterate on it) */
  previousOutput?: string;
  /** Which attempt this is (1-based) */
  attempt?: number;
  /** Current depth in the delegation hierarchy (0 = root) */
  depth?: number;
  /**
   * Delegate subtasks to child agents. Call this from inside execute() to
   * build arbitrarily deep hierarchies. Returns the output of each subtask.
   *
   * Returns undefined if delegation is not available (max depth reached).
   *
   * @example
   * ```ts
   * const agent: Agent = {
   *   async execute(task) {
   *     if (task.delegate) {
   *       const results = await task.delegate([
   *         { prompt: 'Research competitors', name: 'Researcher' },
   *         { prompt: 'Analyze financials', name: 'Analyst' },
   *       ]);
   *       return { status: 'completed', output: results.join('\n\n') };
   *     }
   *     // Leaf node — do the actual work
   *     return { status: 'completed', output: await doWork(task.prompt) };
   *   }
   * };
   * ```
   */
  delegate?: (subtasks: { prompt: string; name?: string; agent?: Agent }[]) => Promise<string[]>;
}

export interface TaskContext {
  /** Output from upstream tasks / parent agents */
  previousOutputs?: string[];
  /** Files available to the agent */
  files?: { path: string; content: string }[];
  /** Knowledge base entries */
  knowledge?: string[];
  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;
}

export interface TaskConstraints {
  maxTokens?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
  /** Restrict which tools/actions the agent can use */
  allowedActions?: string[];
  blockedActions?: string[];
}

export interface TaskOutput {
  status: 'completed' | 'failed' | 'partial';
  output: string;
  /** Artifacts produced (files, images, data) */
  artifacts?: Artifact[];
  /** Self-reported usage for cost tracking */
  usage?: UsageReport;
  error?: string;
}

export interface Artifact {
  name: string;
  type: string;
  content?: string;
  url?: string;
}

export interface UsageReport {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  model?: string;
}

// ── Review ──

export interface ReviewResult {
  approved: boolean;
  confidence: number;
  feedback: string;
}

// ── Worker / Team ──

export type WorkerStatus = 'pending' | 'working' | 'reviewing' | 'delegating' | 'completed' | 'failed' | 'canceled';

export interface WorkerEvent {
  workerId: string;
  workerName: string;
  status: WorkerStatus;
  task: string;
  parentId?: string;
  output?: string;
  error?: string;
}

export interface TeamConfig {
  /** Human-readable name */
  name?: string;
  /** The agent implementation for this team */
  agent: Agent;
  /** Optional reviewer — if omitted, output is auto-approved */
  reviewer?: Reviewer;
  /** Max review-retry cycles before accepting output */
  maxCycles?: number;
  /** Max parallel workers when delegating */
  maxWorkers?: number;
  /** Max delegation depth (0 = no delegation) */
  maxDepth?: number;
  /** Timeout per task in ms */
  timeoutMs?: number;
}

// ── Orchestrator ──

export interface OrchestratorConfig {
  /** Named teams, each with their own agent */
  teams: Record<string, TeamConfig>;
  /** How tasks flow between teams */
  channels?: Channel[];
  /** Global event listener */
  onEvent?: (event: OrchestratorEvent) => void;
}

export interface Channel {
  from: string;
  to: string;
  /** Transform the output before passing to the next team */
  transform?: (output: string) => string;
  /** Gate: if provided, output is held until gate returns true */
  gate?: (output: string) => Promise<boolean> | boolean;
}

export type OrchestratorEvent =
  | { type: 'worker'; event: WorkerEvent }
  | { type: 'task:started'; teamId: string; taskId: string }
  | { type: 'task:completed'; teamId: string; taskId: string; output: string }
  | { type: 'task:failed'; teamId: string; taskId: string; error: string }
  | { type: 'review'; teamId: string; taskId: string; result: ReviewResult; attempt: number }
  | { type: 'delegation'; parentId: string; children: string[] }
  | { type: 'channel:routed'; from: string; to: string; taskId: string }
  | { type: 'channel:gated'; from: string; to: string; taskId: string };
