import { describe, it, expect, afterEach } from 'vitest';
import { AgentBridge, createBridgedAgent, createBridgedReviewer } from '../src/bridge';
import { Worker } from '../src/worker';
import type { Agent, TaskInput } from '../src/types';

let bridges: AgentBridge[] = [];
afterEach(async () => {
  for (const b of bridges) await b.stop();
  bridges = [];
});

describe('AgentBridge', () => {
  it('serves /health', async () => {
    const bridge = new AgentBridge(0);
    const port = await bridge.start();
    bridges.push(bridge);

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.ok).toBe(true);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('serves /task with current task', async () => {
    const bridge = new AgentBridge(0);
    const port = await bridge.start();
    bridges.push(bridge);

    bridge.setTask({ id: 't1', prompt: 'hello', teamId: 'team1' });
    const res = await fetch(`http://127.0.0.1:${port}/task`);
    const body = await res.json() as any;
    expect(body.id).toBe('t1');
    expect(body.prompt).toBe('hello');
    expect(body.canDelegate).toBe(false);
  });

  it('handles /delegate', async () => {
    const bridge = new AgentBridge(0);
    const port = await bridge.start();
    bridges.push(bridge);

    bridge.setHandlers({
      delegate: async (subtasks) => subtasks.map(s => `done: ${s.prompt}`),
      submitReview: () => {},
    });

    const res = await fetch(`http://127.0.0.1:${port}/delegate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subtasks: [{ prompt: 'sub1' }, { prompt: 'sub2' }] }),
    });
    const body = await res.json() as any;
    expect(body.results).toEqual(['done: sub1', 'done: sub2']);
  });

  it('handles /submit-review', async () => {
    const bridge = new AgentBridge(0);
    const port = await bridge.start();
    bridges.push(bridge);

    const reviewPromise = bridge.waitForReview();

    // Simulate agent posting review
    await fetch(`http://127.0.0.1:${port}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, confidence: 0.95, feedback: 'looks good' }),
    });

    const result = await reviewPromise;
    expect(result.approved).toBe(true);
    expect(result.confidence).toBe(0.95);
    expect(result.feedback).toBe('looks good');
  });
});

describe('createBridgedAgent', () => {
  it('passes env vars to the run function', async () => {
    let capturedEnv: Record<string, string> = {};

    const { agent, bridge } = await createBridgedAgent({
      run: async (task, env) => {
        capturedEnv = env;
        return `result: ${task.prompt}`;
      },
    });
    bridges.push(bridge);

    const worker = new Worker({ agent, maxDepth: 0 });
    const result = await worker.run({ id: 't1', prompt: 'test', teamId: 'team1' });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('result: test');
    expect(capturedEnv.ROBAL_BRIDGE_URL).toContain('http://127.0.0.1:');
    expect(capturedEnv.ROBAL_PROMPT).toBe('test');
    expect(capturedEnv.ROBAL_CAN_DELEGATE).toBe('false');
  });

  it('agent can delegate via HTTP', async () => {
    const leafAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: `leaf: ${task.prompt}` };
      },
    };

    const { agent, bridge } = await createBridgedAgent({
      run: async (task, env) => {
        if (env.ROBAL_CAN_DELEGATE === 'true') {
          const res = await fetch(env.ROBAL_DELEGATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subtasks: [{ prompt: 'child-task-1' }, { prompt: 'child-task-2' }] }),
          });
          const body = await res.json() as any;
          return `parent got: ${body.results.join(' + ')}`;
        }
        return `direct: ${task.prompt}`;
      },
    });
    bridges.push(bridge);

    // Use leafAgent for children by wrapping delegate
    const wrapper: Agent = {
      async execute(task) {
        // Override delegate to use leafAgent for children
        const origDelegate = task.delegate;
        if (origDelegate) {
          task = {
            ...task,
            delegate: (subtasks) => origDelegate(subtasks.map(s => ({ ...s, agent: leafAgent }))),
          };
        }
        return agent.execute(task);
      },
    };

    const worker = new Worker({ agent: wrapper, maxDepth: 2 });
    const result = await worker.run({ id: 'root', prompt: 'go', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('parent got:');
    expect(result.output).toContain('leaf: child-task-1');
    expect(result.output).toContain('leaf: child-task-2');
  });
});

describe('createBridgedReviewer', () => {
  it('reviewer receives verdict via HTTP', async () => {
    const bridge = new AgentBridge(0);
    const port = await bridge.start();
    bridges.push(bridge);

    const { reviewer } = createBridgedReviewer(bridge);

    // Start review (will wait for HTTP POST)
    const reviewPromise = reviewer.review(
      { id: 't1', prompt: 'build it', teamId: 'test' },
      { status: 'completed', output: 'done' },
    );

    // Simulate external reviewer posting verdict
    await fetch(`http://127.0.0.1:${port}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false, confidence: 0.3, feedback: 'needs tests' }),
    });

    const result = await reviewPromise;
    expect(result.approved).toBe(false);
    expect(result.feedback).toBe('needs tests');
  });
});
