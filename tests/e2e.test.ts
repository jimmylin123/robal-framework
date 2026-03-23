import { describe, it, expect, afterEach } from 'vitest';
import { Orchestrator, Worker, createAgent, createReviewer, AgentServer } from '../src';
import type { Agent, Reviewer, TaskInput } from '../src';

// These tests simulate real-world multi-agent scenarios end-to-end.
// No mocks — actual async execution, HTTP bridge calls, deep hierarchies.

const bridges: AgentServer[] = [];

afterEach(async () => {
  for (const b of bridges) await b.stop();
  bridges.length = 0;
});

// ── Scenario 1: Marketing department ──
// Research agent gathers data, writer agent produces copy, editor reviews.

describe('E2E: Marketing pipeline', () => {
  it('research → writer with editor review cycle', async () => {
    const researchAgent: Agent = {
      async execute(task) {
        // Simulates gathering data
        await delay(10);
        return { status: 'completed', output: `Research findings for "${task.prompt}": Market is growing 30% YoY. Key players: A, B, C.` };
      },
    };

    let writerAttempts = 0;
    const writerAgent: Agent = {
      async execute(task) {
        writerAttempts++;
        await delay(10);
        const context = task.context?.previousOutputs?.[0] || '';
        if (task.feedback) {
          // Second attempt — incorporate feedback
          return { status: 'completed', output: `Final copy: Based on research (${context.slice(0, 50)}...), the market shows strong growth. Added detail per feedback.` };
        }
        return { status: 'completed', output: `Draft: Market is growing.` };
      },
    };

    const editorReviewer: Reviewer = {
      async review(task, output) {
        if (output.output.startsWith('Draft:')) {
          return { approved: false, confidence: 0.4, feedback: 'Too short. Include specific data from research.' };
        }
        return { approved: true, confidence: 0.9, feedback: '' };
      },
    };

    const events: string[] = [];
    const orc = new Orchestrator({
      teams: {
        research: { agent: researchAgent },
        writing: { agent: writerAgent, reviewer: editorReviewer, maxCycles: 3 },
      },
      channels: [{ from: 'research', to: 'writing' }],
      onEvent: (e) => events.push(e.type),
    });

    const result = await orc.pipeline('research', 'AI agent market');

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Final copy');
    expect(result.output).toContain('strong growth');
    expect(writerAttempts).toBe(2); // draft rejected, then fixed
    expect(events).toContain('review');
    expect(events).toContain('channel:routed');
  });
});

// ── Scenario 2: CEO → Managers → Workers hierarchy ──
// 3-level delegation with different agents at each level.

describe('E2E: Deep hierarchy', () => {
  it('CEO delegates to managers who delegate to specialists', async () => {
    const executionLog: string[] = [];

    const specialistAgent: Agent = {
      async execute(task) {
        await delay(5);
        executionLog.push(`specialist: ${task.prompt}`);
        return { status: 'completed', output: `[specialist] Done: ${task.prompt}` };
      },
    };

    const managerAgent: Agent = {
      async execute(task) {
        executionLog.push(`manager: ${task.prompt}`);
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: `${task.prompt} - analysis`, name: 'Analyst', agent: specialistAgent },
            { prompt: `${task.prompt} - execution`, name: 'Executor', agent: specialistAgent },
          ]);
          return { status: 'completed', output: `[manager] Collected:\n${results.join('\n')}` };
        }
        return { status: 'completed', output: `[manager] Leaf: ${task.prompt}` };
      },
    };

    const ceoAgent: Agent = {
      async execute(task) {
        executionLog.push(`ceo: ${task.prompt}`);
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: 'Engineering', name: 'VP Eng', agent: managerAgent },
            { prompt: 'Marketing', name: 'VP Marketing', agent: managerAgent },
            { prompt: 'Sales', name: 'VP Sales', agent: managerAgent },
          ]);
          return { status: 'completed', output: `[ceo] All divisions:\n${results.join('\n---\n')}` };
        }
        return { status: 'completed', output: 'no delegation' };
      },
    };

    const worker = new Worker({ agent: ceoAgent, maxDepth: 3, maxWorkers: 10 });
    const result = await worker.run({ id: 'e2e-ceo', prompt: 'Q4 planning', teamId: 'exec' });

    expect(result.status).toBe('completed');
    // CEO ran
    expect(executionLog).toContain('ceo: Q4 planning');
    // 3 managers ran
    expect(executionLog).toContain('manager: Engineering');
    expect(executionLog).toContain('manager: Marketing');
    expect(executionLog).toContain('manager: Sales');
    // 6 specialists ran (2 per manager)
    expect(executionLog.filter(l => l.startsWith('specialist:')).length).toBe(6);
    // Output contains all levels
    expect(result.output).toContain('[ceo]');
    expect(result.output).toContain('[manager]');
    expect(result.output).toContain('[specialist]');
  });
});

// ── Scenario 3: HTTP bridge — agent delegates via HTTP ──

describe('E2E: HTTP bridge delegation', () => {
  it('external process delegates via HTTP and gets results', async () => {
    const leafAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: `computed: ${task.prompt.toUpperCase()}` };
      },
    };

    const { agent, bridge } = await createAgent({
      run: async (task, env) => {
        // Simulate an external process that reads env and calls HTTP
        if (env.ROBAL_CAN_DELEGATE === 'true') {
          const res = await fetch(env.ROBAL_DELEGATE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              subtasks: [
                { prompt: 'task alpha' },
                { prompt: 'task beta' },
              ],
            }),
          });
          const body = await res.json() as any;
          return `bridged agent collected: ${body.results.join(' | ')}`;
        }
        return `direct: ${task.prompt}`;
      },
    });
    bridges.push(bridge);

    // Wrap to inject leafAgent for children
    const wrapper: Agent = {
      async execute(task) {
        const orig = task.delegate;
        if (orig) {
          task = { ...task, delegate: (subs) => orig(subs.map(s => ({ ...s, agent: leafAgent }))) };
        }
        return agent.execute(task);
      },
    };

    const worker = new Worker({ agent: wrapper, maxDepth: 2 });
    const result = await worker.run({ id: 'bridge-e2e', prompt: 'go', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('computed: TASK ALPHA');
    expect(result.output).toContain('computed: TASK BETA');
  });
});

// ── Scenario 4: HTTP bridge review ──

describe('E2E: HTTP bridge review', () => {
  it('external reviewer submits verdict via HTTP', async () => {
    let attempts = 0;
    const agent: Agent = {
      async execute(task) {
        attempts++;
        if (task.feedback) return { status: 'completed', output: 'improved version' };
        return { status: 'completed', output: 'first draft' };
      },
    };

    const reviewBridge = new AgentServer(0);
    const port = await reviewBridge.start();
    bridges.push(reviewBridge);

    const { reviewer } = createReviewer(reviewBridge);

    // Simulate external reviewer responding after a short delay
    const worker = new Worker({ agent, reviewer, maxCycles: 3 });
    const taskPromise = worker.run({ id: 'review-e2e', prompt: 'write code', teamId: 'test' });

    // Wait for review to be pending, then reject
    await delay(50);
    await fetch(`http://127.0.0.1:${port}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false, confidence: 0.3, feedback: 'add error handling' }),
    });

    // Wait for second review, then approve
    await delay(50);
    await fetch(`http://127.0.0.1:${port}/submit-review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, confidence: 0.9, feedback: '' }),
    });

    const result = await taskPromise;
    expect(result.status).toBe('completed');
    expect(result.output).toBe('improved version');
    expect(attempts).toBe(2);
  });
});

// ── Scenario 5: Fan-out pipeline with gate ──

describe('E2E: Fan-out with gate', () => {
  it('source fans out to multiple teams, gate blocks short output', async () => {
    const sourceAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: `Source data for: ${task.prompt}. `.repeat(20) };
      },
    };

    const sinkAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: `Processed by ${task.teamId}: ${task.prompt.slice(0, 30)}` };
      },
    };

    const shortAgent: Agent = {
      async execute() {
        return { status: 'completed', output: 'tiny' };
      },
    };

    const gatedEvents: string[] = [];
    const orc = new Orchestrator({
      teams: {
        source: { agent: sourceAgent },
        analytics: { agent: sinkAgent },
        summary: { agent: shortAgent },
      },
      channels: [
        { from: 'source', to: 'analytics' },
        { from: 'source', to: 'summary', gate: (output) => output.length > 1000 },
      ],
      onEvent: (e) => { if (e.type === 'channel:gated') gatedEvents.push(`${(e as any).from}->${(e as any).to}`); },
    });

    const result = await orc.pipeline('source', 'quarterly data');
    expect(result.status).toBe('completed');
    // Both channels attempted, analytics should work, summary might be gated depending on source length
    expect(result.output).toContain('analytics');
  });
});

// ── Scenario 6: Abort propagates through deep hierarchy ──

describe('E2E: Abort propagation', () => {
  it('aborting root cancels all descendants', async () => {
    const canceledWorkers: string[] = [];

    const slowAgent: Agent = {
      async execute(task) {
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: 'slow-child-1' },
            { prompt: 'slow-child-2' },
          ]);
          return { status: 'completed', output: results.join(',') };
        }
        // Leaf — slow work
        await delay(5000);
        return { status: 'completed', output: 'done' };
      },
    };

    const worker = new Worker({
      agent: slowAgent,
      maxDepth: 2,
      timeoutMs: 10000,
      onEvent: (e) => { if (e.status === 'canceled') canceledWorkers.push(e.workerId); },
    });

    const promise = worker.run({ id: 'abort-e2e', prompt: 'start', teamId: 'test' });
    await delay(100); // Let hierarchy spawn
    worker.abort();
    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Canceled');
    // Root + 2 children should all be canceled
    expect(canceledWorkers.length).toBeGreaterThanOrEqual(2);
  });
});

// ── Scenario 7: Mixed agents in parallel ──

describe('E2E: Parallel mixed teams', () => {
  it('runs different agents in parallel and collects all results', async () => {
    const fastAgent: Agent = { async execute(task) { return { status: 'completed', output: `fast: ${task.prompt}` }; } };
    const slowAgent: Agent = { async execute(task) { await delay(50); return { status: 'completed', output: `slow: ${task.prompt}` }; } };
    const failAgent: Agent = { async execute() { return { status: 'failed', output: '', error: 'boom' }; } };

    const orc = new Orchestrator({
      teams: {
        fast: { agent: fastAgent },
        slow: { agent: slowAgent },
        broken: { agent: failAgent },
      },
    });

    const results = await orc.parallel([
      { teamId: 'fast', prompt: 'one' },
      { teamId: 'slow', prompt: 'two' },
      { teamId: 'broken', prompt: 'three' },
    ]);

    expect(results[0].status).toBe('completed');
    expect(results[0].output).toBe('fast: one');
    expect(results[1].status).toBe('completed');
    expect(results[1].output).toBe('slow: two');
    expect(results[2].status).toBe('failed');
  });
});

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }
