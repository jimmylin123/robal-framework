# robal-framework

Agent orchestration framework. Plug any AI agents, delegate work, review output, coordinate teams.

robal-framework is **not** an agent — it's the layer that makes agents work together. Bring any CLI agent (Kiro, Claude Code, Aider, custom scripts) and this framework handles delegation, review cycles, and multi-agent coordination.

## Install

```bash
npm install robal-framework
```

## Quick Start

```ts
import { createAgentTeam } from 'robal-framework';

const result = await createAgentTeam({
  rootAgent: 'kiro-cli chat --no-interactive --trust-all-tools',
  prompt: 'Build a REST API for user management',
});

console.log(result.output);
```

That's it. The framework starts the agent, tells it what it can do, and collects the result.

## Delegation

The root agent can delegate subtasks to specialist agents. The framework tells the agent who's available — the agent decides whether to delegate or do the work itself.

```ts
const result = await createAgentTeam({
  rootAgent: 'kiro-cli chat --no-interactive --trust-all-tools',
  prompt: 'Build a full-stack app with a landing page',
  availableAgents: [
    { name: 'code-agent', description: 'Writes backend code', agent: 'kiro-cli chat --no-interactive --trust-all-tools' },
    { name: 'design-agent', description: 'Creates UI designs', agent: 'dalle-cli generate' },
    { name: 'research-agent', description: 'Searches the web', agent: 'perplexity-cli search' },
  ],
});
```

The root agent receives instructions like:

```
Your task: Build a full-stack app with a landing page

Available agents you can delegate to:
- "code-agent": Writes backend code
- "design-agent": Creates UI designs
- "research-agent": Searches the web

Decide: either do the work yourself, or delegate subtasks to sub-agents.
```

The agent calls the framework's delegate endpoint, the framework starts the specialist agents, collects their results, and returns them. Delegation can go multiple levels deep — a specialist can delegate further.

## Review Cycle

Add a reviewer to reject bad output and force retries with feedback:

```ts
const result = await createAgentTeam({
  rootAgent: 'kiro-cli chat --no-interactive --trust-all-tools',
  prompt: 'Write a Python web scraper',
  reviewer: 'kiro-cli chat --no-interactive --trust-all-tools',
  maxCycles: 3,
});
```

Flow: `agent executes → reviewer rejects with feedback → agent retries → reviewer approves → done`

## How It Works

The framework runs a local HTTP server and passes the URL to each agent via environment variables. Agents interact with the framework by calling these endpoints:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/task` | GET | Read current task (prompt, context, feedback) |
| `/delegate` | POST | Spawn sub-agents, get back results |
| `/submit-result` | POST | Submit final output |
| `/submit-review` | POST | Submit review verdict |

Any process that can make HTTP calls can be an agent — Python, Rust, shell scripts, or any CLI tool. The framework pipes instructions to stdin and sets `ROBAL_*` environment variables.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ROBAL_BRIDGE_URL` | Base URL of the framework server |
| `ROBAL_PROMPT` | The task prompt |
| `ROBAL_RESULT_URL` | POST here to submit your result |
| `ROBAL_DELEGATE_URL` | POST here to delegate subtasks |
| `ROBAL_TASK_URL` | GET here to read full task details |
| `ROBAL_CAN_DELEGATE` | `"true"` or `"false"` |
| `ROBAL_DEPTH` | Current depth in delegation hierarchy |
| `ROBAL_FEEDBACK` | Reviewer feedback (if retrying) |
| `ROBAL_INSTRUCTIONS` | Full prompt with task + available actions |

## Advanced: Orchestrator API

For more control, use the `Orchestrator` class to wire multiple teams with channels:

```ts
import { Orchestrator, createAgent } from 'robal-framework';

const { agent: researcher } = await createAgent({
  command: 'kiro-cli chat --no-interactive --trust-all-tools',
});
const { agent: writer } = await createAgent({
  command: 'kiro-cli chat --no-interactive --trust-all-tools',
});

const orc = new Orchestrator({
  teams: {
    research: { agent: researcher },
    writing: { agent: writer, reviewer: myReviewer, maxCycles: 3 },
  },
  channels: [
    { from: 'research', to: 'writing' },
  ],
});

// Run a pipeline: research → writing
const result = await orc.pipeline('research', 'Write a report on AI agents');

// Or run teams in parallel
const results = await orc.parallel([
  { teamId: 'research', prompt: 'Market trends' },
  { teamId: 'writing', prompt: 'Blog post draft' },
]);
```

### Channels

Connect teams. Output from one flows as input to the next:

```ts
channels: [
  { from: 'research', to: 'writing' },
  { from: 'writing', to: 'review', transform: (output) => `Review this: ${output}` },
  { from: 'review', to: 'publish', gate: (output) => output.includes('approved') },
]
```

### Events

```ts
const orc = new Orchestrator({
  teams: { ... },
  onEvent: (event) => {
    // event.type: 'task:started' | 'task:completed' | 'task:failed' | 'worker' | 'review' | 'channel:routed' | 'channel:gated'
    console.log(event.type);
  },
});
```

## Advanced: Agent Interface

For programmatic agents (not CLI), implement the `Agent` interface directly:

```ts
import { Orchestrator } from 'robal-framework';
import type { Agent } from 'robal-framework';

const myAgent: Agent = {
  async execute(task) {
    // task.prompt — what to do
    // task.delegate — function to spawn sub-agents (if available)
    // task.feedback — why the reviewer rejected last attempt
    // task.context — outputs from upstream tasks

    if (task.delegate) {
      const results = await task.delegate([
        { prompt: 'subtask 1', name: 'specialist-a' },
        { prompt: 'subtask 2', name: 'specialist-b' },
      ]);
      return { status: 'completed', output: results.join('\n') };
    }

    return { status: 'completed', output: 'done' };
  },
};
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `maxCycles` | 3 | Max review-retry cycles per task |
| `maxWorkers` | 5 | Max parallel sub-agents when delegating |
| `maxDepth` | 3 | Max delegation depth (0 = no delegation) |
| `timeoutMs` | 120000 | Timeout per agent invocation (2 min) |

## License

MIT
