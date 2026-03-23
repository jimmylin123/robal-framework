import type { Agent, Reviewer, TaskInput, TaskOutput, ReviewResult, WorkerStatus, WorkerEvent } from './types';

let workerCounter = 0;

/** Reset the internal worker counter. Useful for testing. */
export function _resetWorkerCounter() { workerCounter = 0; }

export class Worker {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  private agent: Agent;
  private reviewer: Reviewer | null;
  private maxCycles: number;
  private timeoutMs: number;
  private depth: number;
  private maxDepth: number;
  private maxWorkers: number;
  private onEvent: (event: WorkerEvent) => void;
  private onReview: ((task: TaskInput, result: ReviewResult, attempt: number) => void) | null;
  private aborted = false;
  private activeChildren: Worker[] = [];
  status: WorkerStatus = 'pending';

  constructor(opts: {
    agent: Agent;
    reviewer?: Reviewer;
    maxCycles?: number;
    maxDepth?: number;
    maxWorkers?: number;
    timeoutMs?: number;
    depth?: number;
    parentId?: string | null;
    name?: string;
    onEvent?: (event: WorkerEvent) => void;
    onReview?: (task: TaskInput, result: ReviewResult, attempt: number) => void;
  }) {
    this.id = `w-${Date.now().toString(36)}-${++workerCounter}`;
    this.name = opts.name || `Worker ${workerCounter}`;
    this.agent = opts.agent;
    this.reviewer = opts.reviewer ?? null;
    this.maxCycles = opts.maxCycles ?? 3;
    this.maxDepth = opts.maxDepth ?? 2;
    this.maxWorkers = opts.maxWorkers ?? 5;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.depth = opts.depth ?? 0;
    this.parentId = opts.parentId ?? null;
    this.onEvent = opts.onEvent || (() => {});
    this.onReview = opts.onReview || null;
  }

  abort() {
    this.aborted = true;
    // Propagate to all children spawned via delegate handle
    for (const child of this.activeChildren) {
      child.abort();
    }
    this.activeChildren = [];
    this.emit('canceled');
  }

  private emit(status: WorkerStatus, output?: string, error?: string) {
    this.status = status;
    this.onEvent({ workerId: this.id, workerName: this.name, status, task: '', parentId: this.parentId || undefined, output, error });
  }

  /**
   * Run the agent through the review cycle.
   * execute → review → feedback → retry (up to maxCycles)
   */
  async run(task: TaskInput): Promise<TaskOutput> {
    this.emit('working');
    let lastOutput: TaskOutput = { status: 'failed', output: '', error: 'No execution' };
    let feedback: string | undefined;
    let previousOutput: string | undefined;

    for (let attempt = 1; attempt <= this.maxCycles; attempt++) {
      if (this.aborted) { this.emit('canceled'); return { status: 'failed', output: '', error: 'Canceled' }; }

      // Execute
      this.emit('working');
      const delegateHandle = this.depth < this.maxDepth
        ? (subtasks: { prompt: string; name?: string; agent?: Agent }[]) => this.delegate(subtasks, task)
        : undefined;
      const input: TaskInput = { ...task, feedback, previousOutput, attempt, depth: this.depth, delegate: delegateHandle };
      try {
        lastOutput = await this.executeWithTimeout(input);
      } catch (err: any) {
        if (this.aborted) { this.emit('canceled'); return { status: 'failed', output: '', error: 'Canceled' }; }
        lastOutput = { status: 'failed', output: '', error: err.message };
        this.emit('failed', undefined, err.message);
        return lastOutput;
      }

      if (lastOutput.status === 'failed') {
        this.emit('failed', lastOutput.output, lastOutput.error);
        return lastOutput;
      }

      // Review
      if (!this.reviewer) {
        this.emit('completed', lastOutput.output);
        return lastOutput;
      }

      this.emit('reviewing');
      let review: ReviewResult;
      try {
        review = await this.reviewer.review(task, lastOutput);
      } catch {
        // Reviewer failed — accept the output
        this.emit('completed', lastOutput.output);
        return lastOutput;
      }

      this.onReview?.(task, review, attempt);

      if (review.approved) {
        this.emit('completed', lastOutput.output);
        return lastOutput;
      }

      // Rejected — feed back for next attempt
      feedback = review.feedback;
      previousOutput = lastOutput.output;
      if (attempt === this.maxCycles) {
        this.emit('completed', lastOutput.output);
        return lastOutput;
      }
    }

    this.emit('completed', lastOutput.output);
    return lastOutput;
  }

  /**
   * Delegate subtasks to child workers, run in parallel, collect results.
   * Optionally pass a different agent per subtask for mixed-agent delegation.
   */
  async delegate(subtasks: { prompt: string; name?: string; agent?: Agent }[], parentTask: TaskInput): Promise<string[]> {
    if (this.depth >= this.maxDepth) {
      throw new Error(`Max delegation depth (${this.maxDepth}) reached`);
    }
    if (this.aborted) throw new Error('Canceled');

    this.emit('delegating');
    const limited = subtasks.slice(0, this.maxWorkers);

    const children = limited.map((sub, i) => {
      const child = new Worker({
        agent: sub.agent || this.agent,
        reviewer: this.reviewer || undefined,
        maxCycles: this.maxCycles,
        maxDepth: this.maxDepth,
        maxWorkers: this.maxWorkers,
        timeoutMs: this.timeoutMs,
        depth: this.depth + 1,
        parentId: this.id,
        name: sub.name || `${this.name} → Sub ${i + 1}`,
        onEvent: this.onEvent,
        onReview: this.onReview || undefined,
      });
      return child;
    });

    // Track children so abort() can propagate
    this.activeChildren.push(...children);

    const results = await Promise.allSettled(
      children.map((child, i) =>
        child.run({
          id: `${parentTask.id}-sub-${i}`,
          prompt: limited[i].prompt,
          teamId: parentTask.teamId,
          context: parentTask.context,
          constraints: parentTask.constraints,
        })
      )
    );

    // Clean up — children are done
    this.activeChildren = this.activeChildren.filter(c => !children.includes(c));
    this.emit('working');

    return results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value.output;
      return `[${limited[i].name || `Sub ${i + 1}`}] Error: ${r.reason?.message || 'Unknown'}`;
    });
  }

  private executeWithTimeout(task: TaskInput): Promise<TaskOutput> {
    return new Promise<TaskOutput>((resolve, reject) => {
      if (this.aborted) { reject(new Error('Canceled')); return; }
      const timer = setTimeout(() => reject(new Error(`Task timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
      const checkAbort = setInterval(() => { if (this.aborted) { clearInterval(checkAbort); clearTimeout(timer); reject(new Error('Canceled')); } }, 10);
      this.agent.execute(task).then(resolve, reject).finally(() => { clearTimeout(timer); clearInterval(checkAbort); });
    });
  }
}
