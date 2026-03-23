# robal-framework

Agent orchestration framework. Delegate, review, and coordinate any AI agents.

robal-framework is **not** an agent — it's the layer that makes agents work together. Bring your own agents (OpenAI, Anthropic, LangChain, custom) and this framework handles delegation, review cycles, and multi-team coordination.

## Install

```bash
npm install robal-framework
```

## Quick Start

```ts
import { Orchestrator } from 'robal-framework';
import type { Agent, Reviewer } from 'robal-framework';

// 1. Implement the Agent interface (your LLM wrapper)
const codeAgent: Agent = {
  async execute(task) {
    const result = await yourLLM.chat(task.prompt);
    return { status: 'completed', output: result };
  },
};

// 2. Optionally implement a Reviewer
const codeReviewer: Reviewer = {
  async review(task, output) {
    const score = await yourLLM.judge(task.prompt, output.output);
    return {
      approved: score > 0.8,
      confidence: score,
      feedback: score <= 0.8 ? 'Needs improvement' : '',
    };
  },
};

// 3. Wire teams together
const orc = new Orchestrator({
  teams: {
    backend:  { agent: codeAgent, reviewer: codeReviewer, maxCycles: 3 },
    frontend: { agent: codeAgent },
  },
  channels: [
    { from: 'backend', to: 'frontend' },
  ],
});

// 4. Run
const result = await orc.run('backend', 'Build a REST API for user management');
// Or run a pipeline across teams:
const final = await orc.pipeline('backend', 'Build a full-stack user management app');
```

## Core Concepts

### Agent

The only interface you implement. An agent receives a task and returns a result:

```ts
interface Agent {
  execute(task: TaskInput): Promise<TaskOutput>;
}
```

`TaskInput` gives you the prompt, context from previous steps, constraints, and feedback from review cycles. `TaskOutput` is your result with optional artifacts and usage metrics.

### Reviewer

Optional. Evaluates agent output and decides whether to approve or request a retry:

```ts
interface Reviewer {
  review(task: TaskInput, output: TaskOutput): Promise<ReviewResult>;
}
```

If no reviewer is provided, output is auto-approved. If the reviewer rejects, the agent gets the feedback and tries again (up to `maxCycles`).

### Team

A named unit with an agent and optional reviewer. Teams process tasks independently:

```ts
const orc = new Orchestrator({
  teams: {
    research:  { agent: researchAgent, maxWorkers: 5 },
    writing:   { agent: writerAgent, reviewer: editorAgent, maxCycles: 3 },
    design:    { agent: designAgent },
  },
});
```

### Channel

Connects teams. Output from one team flows as input to the next:

```ts
channels: [
  { from: 'research', to: 'writing' },
  { from: 'writing', to: 'design', transform: (output) => `Design for: ${output}` },
]
```

### Gate

A channel can have a gate — a function that decides whether output should flow through:

```ts
channels: [
  {
    from: 'draft', to: 'publish',
    gate: async (output) => {
      // Human approval, policy check, quality threshold, etc.
      return output.length > 100;
    },
  },
]
```

### Delegation

Workers can spawn child workers for parallel subtasks:

```ts
const team = orc.team('research');
const results = await team.delegate(
  [
    { prompt: 'Research competitor A', name: 'Analyst 1' },
    { prompt: 'Research competitor B', name: 'Analyst 2' },
  ],
  'Competitive analysis',
);
```

### Parallel Execution

Run multiple teams simultaneously:

```ts
const results = await orc.parallel([
  { teamId: 'research', prompt: 'Market trends' },
  { teamId: 'design', prompt: 'UI mockups' },
  { teamId: 'backend', prompt: 'API design' },
]);
```

## Events

Subscribe to orchestration events for observability:

```ts
const orc = new Orchestrator({
  teams: { ... },
  onEvent: (event) => {
    switch (event.type) {
      case 'task:started':   console.log(`Task started: ${event.taskId}`); break;
      case 'task:completed': console.log(`Done: ${event.output.slice(0, 100)}`); break;
      case 'worker':         console.log(`Worker ${event.event.workerName}: ${event.event.status}`); break;
      case 'review':         console.log(`Review: ${event.result.approved ? '✅' : '❌'}`); break;
      case 'channel:routed': console.log(`${event.from} → ${event.to}`); break;
    }
  },
});
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxCycles` | 3 | Max review-retry cycles per task |
| `maxWorkers` | 5 | Max parallel child workers when delegating |
| `maxDepth` | 2 | Max delegation depth (0 = no delegation) |
| `timeoutMs` | 300000 | Timeout per task execution (5 min) |

## License

MIT
