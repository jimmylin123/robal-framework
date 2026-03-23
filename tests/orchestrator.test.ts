import { describe, it, expect, vi } from 'vitest';
import { Orchestrator, Worker, Team } from '../src';
import type { Agent, Reviewer, TaskInput, TaskOutput, OrchestratorEvent } from '../src';

// ── Test agents ──

const echoAgent: Agent = {
  async execute(task) {
    return { status: 'completed', output: `echo: ${task.prompt}` };
  },
};

const failAgent: Agent = {
  async execute() {
    return { status: 'failed', output: '', error: 'intentional failure' };
  },
};

const counterAgent = (prefix: string): Agent => {
  let calls = 0;
  return {
    async execute(task) {
      calls++;
      if (task.feedback && calls >= 2) {
        return { status: 'completed', output: `${prefix}: fixed after feedback` };
      }
      return { status: 'completed', output: `${prefix}: attempt ${calls}` };
    },
  };
};

const strictReviewer: Reviewer = {
  async review(task, output) {
    if (output.output.includes('fixed')) return { approved: true, confidence: 0.9, feedback: '' };
    return { approved: false, confidence: 0.3, feedback: 'Not good enough' };
  },
};

const autoApproveReviewer: Reviewer = {
  async review() {
    return { approved: true, confidence: 1, feedback: '' };
  },
};

// ── Worker tests ──

describe('Worker', () => {
  it('runs agent and returns output', async () => {
    const worker = new Worker({ agent: echoAgent });
    const result = await worker.run({ id: 't1', prompt: 'hello', teamId: 'test' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('echo: hello');
  });

  it('returns failed status on agent failure', async () => {
    const worker = new Worker({ agent: failAgent });
    const result = await worker.run({ id: 't2', prompt: 'fail', teamId: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('intentional failure');
  });

  it('retries with reviewer feedback', async () => {
    const agent = counterAgent('w');
    const worker = new Worker({ agent, reviewer: strictReviewer, maxCycles: 3 });
    const result = await worker.run({ id: 't3', prompt: 'do it', teamId: 'test' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('w: fixed after feedback');
  });

  it('auto-approves without reviewer', async () => {
    const agent = counterAgent('x');
    const worker = new Worker({ agent, maxCycles: 3 });
    const result = await worker.run({ id: 't4', prompt: 'go', teamId: 'test' });
    expect(result.output).toBe('x: attempt 1');
  });

  it('emits status events', async () => {
    const events: string[] = [];
    const worker = new Worker({
      agent: echoAgent,
      onEvent: (e) => events.push(e.status),
    });
    await worker.run({ id: 't5', prompt: 'hi', teamId: 'test' });
    expect(events).toContain('working');
    expect(events).toContain('completed');
  });

  it('delegates to child workers', async () => {
    const worker = new Worker({ agent: echoAgent, maxDepth: 2 });
    const results = await worker.delegate(
      [{ prompt: 'sub1' }, { prompt: 'sub2' }],
      { id: 'parent', prompt: 'parent task', teamId: 'test' },
    );
    expect(results).toHaveLength(2);
    expect(results[0]).toBe('echo: sub1');
    expect(results[1]).toBe('echo: sub2');
  });

  it('supports mixed-agent delegation', async () => {
    const agentA: Agent = { async execute() { return { status: 'completed', output: 'from-A' }; } };
    const agentB: Agent = { async execute() { return { status: 'completed', output: 'from-B' }; } };
    const worker = new Worker({ agent: echoAgent, maxDepth: 2 });
    const results = await worker.delegate(
      [{ prompt: 'task1', agent: agentA }, { prompt: 'task2', agent: agentB }],
      { id: 'p', prompt: 'parent', teamId: 'test' },
    );
    expect(results[0]).toBe('from-A');
    expect(results[1]).toBe('from-B');
  });

  it('injects delegate handle into TaskInput', async () => {
    let receivedDelegate: any = null;
    let receivedDepth: any = null;
    const spy: Agent = {
      async execute(task) {
        receivedDelegate = task.delegate;
        receivedDepth = task.depth;
        return { status: 'completed', output: 'done' };
      },
    };
    const worker = new Worker({ agent: spy, maxDepth: 2 });
    await worker.run({ id: 't', prompt: 'go', teamId: 'test' });
    expect(typeof receivedDelegate).toBe('function');
    expect(receivedDepth).toBe(0);
  });

  it('delegate handle is undefined at max depth', async () => {
    let receivedDelegate: any = 'not-set';
    const spy: Agent = {
      async execute(task) {
        receivedDelegate = task.delegate;
        return { status: 'completed', output: 'leaf' };
      },
    };
    const worker = new Worker({ agent: spy, maxDepth: 0 });
    await worker.run({ id: 't', prompt: 'go', teamId: 'test' });
    expect(receivedDelegate).toBeUndefined();
  });

  it('supports deep hierarchy via delegate handle', async () => {
    // 3-level hierarchy: root → managers → leaf workers
    const leafAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: `leaf: ${task.prompt}` };
      },
    };

    const managerAgent: Agent = {
      async execute(task) {
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: `${task.prompt} - subtask A`, agent: leafAgent },
            { prompt: `${task.prompt} - subtask B`, agent: leafAgent },
          ]);
          return { status: 'completed', output: `manager collected: ${results.join(' | ')}` };
        }
        return { status: 'completed', output: `manager leaf: ${task.prompt}` };
      },
    };

    const ceoAgent: Agent = {
      async execute(task) {
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: 'division-1', name: 'Manager 1', agent: managerAgent },
            { prompt: 'division-2', name: 'Manager 2', agent: managerAgent },
          ]);
          return { status: 'completed', output: `CEO: ${results.join(' || ')}` };
        }
        return { status: 'completed', output: 'no delegation' };
      },
    };

    const worker = new Worker({ agent: ceoAgent, maxDepth: 3, maxWorkers: 10 });
    const result = await worker.run({ id: 'root', prompt: 'run company', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('CEO:');
    expect(result.output).toContain('manager collected:');
    expect(result.output).toContain('leaf: division-1 - subtask A');
    expect(result.output).toContain('leaf: division-1 - subtask B');
    expect(result.output).toContain('leaf: division-2 - subtask A');
    expect(result.output).toContain('leaf: division-2 - subtask B');
  });

  it('respects max delegation depth', async () => {
    const worker = new Worker({ agent: echoAgent, maxDepth: 0, depth: 0 });
    await expect(
      worker.delegate([{ prompt: 'sub' }], { id: 'p', prompt: 'p', teamId: 'test' })
    ).rejects.toThrow('Max delegation depth');
  });

  it('respects timeout', async () => {
    const slowAgent: Agent = {
      async execute() {
        await new Promise(r => setTimeout(r, 5000));
        return { status: 'completed', output: 'done' };
      },
    };
    const worker = new Worker({ agent: slowAgent, timeoutMs: 50 });
    const result = await worker.run({ id: 't6', prompt: 'slow', teamId: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timed out');
  });

  it('abort propagates through delegate hierarchy', async () => {
    const abortedIds: string[] = [];

    const slowLeaf: Agent = {
      async execute(task) {
        await new Promise(r => setTimeout(r, 5000));
        return { status: 'completed', output: 'should not reach' };
      },
    };

    const parentAgent: Agent = {
      async execute(task) {
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: 'child1', name: 'Child 1', agent: slowLeaf },
            { prompt: 'child2', name: 'Child 2', agent: slowLeaf },
          ]);
          return { status: 'completed', output: results.join(',') };
        }
        return { status: 'completed', output: 'no delegate' };
      },
    };

    const worker = new Worker({
      agent: parentAgent,
      maxDepth: 2,
      timeoutMs: 10000,
      onEvent: (e) => { if (e.status === 'canceled') abortedIds.push(e.workerId); },
    });

    const promise = worker.run({ id: 'root', prompt: 'go', teamId: 'test' });
    // Wait for children to spawn, then abort
    await new Promise(r => setTimeout(r, 50));
    worker.abort();
    const result = await promise;

    expect(result.status).toBe('failed');
    expect(result.error).toBe('Canceled');
    // Parent + 2 children should all be canceled
    expect(abortedIds.length).toBeGreaterThanOrEqual(2);
  });

  it('can be aborted', async () => {
    const slowAgent: Agent = {
      async execute() {
        await new Promise(r => setTimeout(r, 5000));
        return { status: 'completed', output: 'done' };
      },
    };
    const worker = new Worker({ agent: slowAgent, timeoutMs: 10000 });
    const promise = worker.run({ id: 't7', prompt: 'slow', teamId: 'test' });
    setTimeout(() => worker.abort(), 10);
    const result = await promise;
    expect(result.status).toBe('failed');
  });
});

// ── Orchestrator tests ──

describe('Orchestrator', () => {
  it('runs a single team', async () => {
    const orc = new Orchestrator({ teams: { echo: { agent: echoAgent } } });
    const result = await orc.run('echo', 'hello');
    expect(result.output).toBe('echo: hello');
  });

  it('throws on unknown team', async () => {
    const orc = new Orchestrator({ teams: { echo: { agent: echoAgent } } });
    await expect(orc.run('nope', 'hi')).rejects.toThrow("Team 'nope' not found");
  });

  it('runs a pipeline through channels', async () => {
    const upper: Agent = {
      async execute(task) {
        return { status: 'completed', output: task.prompt.toUpperCase() };
      },
    };
    const orc = new Orchestrator({
      teams: {
        step1: { agent: echoAgent },
        step2: { agent: upper },
      },
      channels: [{ from: 'step1', to: 'step2' }],
    });
    const result = await orc.pipeline('step1', 'hello');
    expect(result.output).toBe('ECHO: HELLO');
  });

  it('applies channel transform', async () => {
    const orc = new Orchestrator({
      teams: {
        a: { agent: echoAgent },
        b: { agent: echoAgent },
      },
      channels: [{
        from: 'a', to: 'b',
        transform: (output) => `transformed: ${output}`,
      }],
    });
    const result = await orc.pipeline('a', 'hi');
    expect(result.output).toBe('echo: transformed: echo: hi');
  });

  it('respects channel gate', async () => {
    const orc = new Orchestrator({
      teams: {
        a: { agent: echoAgent },
        b: { agent: echoAgent },
      },
      channels: [{
        from: 'a', to: 'b',
        gate: () => false, // always block
      }],
    });
    const result = await orc.pipeline('a', 'hi');
    // Gate blocked — returns step1 output
    expect(result.output).toBe('echo: hi');
  });

  it('runs teams in parallel', async () => {
    const orc = new Orchestrator({
      teams: {
        a: { agent: echoAgent },
        b: { agent: echoAgent },
      },
    });
    const results = await orc.parallel([
      { teamId: 'a', prompt: 'one' },
      { teamId: 'b', prompt: 'two' },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].output).toBe('echo: one');
    expect(results[1].output).toBe('echo: two');
  });

  it('emits events', async () => {
    const events: OrchestratorEvent[] = [];
    const orc = new Orchestrator({
      teams: { echo: { agent: echoAgent } },
      onEvent: (e) => events.push(e),
    });
    await orc.run('echo', 'hi');
    expect(events.some(e => e.type === 'task:started')).toBe(true);
    expect(events.some(e => e.type === 'task:completed')).toBe(true);
  });

  it('emits review events', async () => {
    const events: OrchestratorEvent[] = [];
    const agent = counterAgent('rv');
    const orc = new Orchestrator({
      teams: { dev: { agent, reviewer: strictReviewer, maxCycles: 3 } },
      onEvent: (e) => events.push(e),
    });
    await orc.run('dev', 'build it');
    const reviewEvents = events.filter(e => e.type === 'review');
    expect(reviewEvents.length).toBeGreaterThanOrEqual(1);
    // First review should reject
    expect((reviewEvents[0] as any).result.approved).toBe(false);
    // Last review should approve
    expect((reviewEvents[reviewEvents.length - 1] as any).result.approved).toBe(true);
  });

  it('handles fan-out channels', async () => {
    const orc = new Orchestrator({
      teams: {
        source: { agent: echoAgent },
        sink1: { agent: echoAgent },
        sink2: { agent: echoAgent },
      },
      channels: [
        { from: 'source', to: 'sink1' },
        { from: 'source', to: 'sink2' },
      ],
    });
    const result = await orc.pipeline('source', 'data');
    expect(result.output).toContain('[sink1]');
    expect(result.output).toContain('[sink2]');
  });

  it('stops pipeline on failure', async () => {
    const orc = new Orchestrator({
      teams: {
        a: { agent: failAgent },
        b: { agent: echoAgent },
      },
      channels: [{ from: 'a', to: 'b' }],
    });
    const result = await orc.pipeline('a', 'hi');
    expect(result.status).toBe('failed');
  });

  it('multi-agent review cycle end-to-end', async () => {
    const agent = counterAgent('e2e');
    const orc = new Orchestrator({
      teams: {
        dev: { agent, reviewer: strictReviewer, maxCycles: 3 },
      },
    });
    const result = await orc.run('dev', 'build feature');
    expect(result.output).toBe('e2e: fixed after feedback');
  });
});
