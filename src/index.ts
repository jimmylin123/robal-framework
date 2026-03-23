// robal-framework — Agent orchestration framework
// Delegate, review, and coordinate any AI agents.

export { Orchestrator } from './orchestrator';
export { Team } from './team';
export { Worker } from './worker';
export { AgentBridge, createBridgedAgent, createBridgedReviewer } from './bridge';
export type { AvailableAgent } from './bridge';

export type {
  // Agent contract — implement these
  Agent,
  Reviewer,

  // Task I/O
  TaskInput,
  TaskOutput,
  TaskContext,
  TaskConstraints,
  Artifact,
  UsageReport,
  ReviewResult,

  // Configuration
  TeamConfig,
  OrchestratorConfig,
  Channel,

  // Events
  WorkerStatus,
  WorkerEvent,
  OrchestratorEvent,
} from './types';
