import type { TeamConfig, TaskInput, TaskOutput, WorkerEvent, OrchestratorEvent, Agent } from './types';
import { Worker } from './worker';

let taskCounter = 0;

export class Team {
  readonly id: string;
  readonly name: string;
  private config: TeamConfig;
  private emit: (event: OrchestratorEvent) => void;

  constructor(id: string, config: TeamConfig, emit: (event: OrchestratorEvent) => void) {
    this.id = id;
    this.name = config.name || id;
    this.config = config;
    this.emit = emit;
  }

  /** Run a single task through this team's agent + review cycle. */
  async run(prompt: string, context?: TaskInput['context']): Promise<TaskOutput> {
    const taskId = `task-${++taskCounter}-${Date.now().toString(36)}`;
    const task: TaskInput = { id: taskId, prompt, teamId: this.id, context };

    this.emit({ type: 'task:started', teamId: this.id, taskId });

    const worker = new Worker({
      agent: this.config.agent,
      reviewer: this.config.reviewer,
      maxCycles: this.config.maxCycles,
      maxDepth: this.config.maxDepth,
      maxWorkers: this.config.maxWorkers,
      timeoutMs: this.config.timeoutMs,
      name: this.name,
      onEvent: (event: WorkerEvent) => this.emit({ type: 'worker', event }),
      onReview: (task, result, attempt) => this.emit({ type: 'review', teamId: this.id, taskId: task.id, result, attempt }),
    });

    const output = await worker.run(task);

    if (output.status === 'failed') {
      this.emit({ type: 'task:failed', teamId: this.id, taskId, error: output.error || 'Unknown error' });
    } else {
      this.emit({ type: 'task:completed', teamId: this.id, taskId, output: output.output });
    }

    return output;
  }

  /** Delegate subtasks to parallel child workers under this team. Optionally pass a different agent per subtask. */
  async delegate(subtasks: { prompt: string; name?: string; agent?: Agent }[], parentPrompt: string, context?: TaskInput['context']): Promise<string[]> {
    const parentTaskId = `task-${++taskCounter}-${Date.now().toString(36)}`;
    const parentTask: TaskInput = { id: parentTaskId, prompt: parentPrompt, teamId: this.id, context };

    const worker = new Worker({
      agent: this.config.agent,
      reviewer: this.config.reviewer,
      maxCycles: this.config.maxCycles,
      maxDepth: this.config.maxDepth,
      maxWorkers: this.config.maxWorkers,
      timeoutMs: this.config.timeoutMs,
      name: this.name,
      onEvent: (event: WorkerEvent) => this.emit({ type: 'worker', event }),
      onReview: (task, result, attempt) => this.emit({ type: 'review', teamId: this.id, taskId: task.id, result, attempt }),
    });

    return worker.delegate(subtasks, parentTask);
  }
}
