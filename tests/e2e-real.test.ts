import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createBridgedAgent, createBridgedReviewer, AgentBridge } from '../src/bridge';
import { Orchestrator, Worker } from '../src';
import type { Agent, Reviewer } from '../src';

const bridges: AgentBridge[] = [];
afterEach(async () => {
  for (const b of bridges) await b.stop();
  bridges.length = 0;
});

function sh(cmd: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
  });
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. Basic bridge protocol ──

describe('Bridge: basic protocol', () => {
  it('agent reads task, does work, POSTs result', async () => {
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"processed: '${env.ROBAL_PROMPT}'"}'`, env);
      },
    });
    bridges.push(bridge);
    const result = await new Worker({ agent }).run({ id: 't1', prompt: 'hello', teamId: 'test' });
    expect(result.status).toBe('completed');
    expect(result.output).toBe('processed: hello');
  });

  it('agent reads full task context from GET /task', async () => {
    let taskFromBridge: any = null;
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        const json = await sh(`curl -s ${env.ROBAL_TASK_URL}`, env);
        taskFromBridge = JSON.parse(json);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"ok"}'`, env);
      },
    });
    bridges.push(bridge);
    await new Worker({ agent, maxDepth: 2 }).run({
      id: 't2', prompt: 'work', teamId: 'team1',
      context: { knowledge: ['k1', 'k2'], previousOutputs: ['prev'] },
    });
    expect(taskFromBridge.prompt).toBe('work');
    expect(taskFromBridge.teamId).toBe('team1');
    expect(taskFromBridge.canDelegate).toBe(true);
    expect(taskFromBridge.context.knowledge).toEqual(['k1', 'k2']);
    expect(taskFromBridge.context.previousOutputs).toEqual(['prev']);
  });

  it('agent reports failure via POST', async () => {
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"failed","output":"","error":"disk full"}'`, env);
      },
    });
    bridges.push(bridge);
    const result = await new Worker({ agent }).run({ id: 't3', prompt: 'go', teamId: 'test' });
    expect(result.status).toBe('failed');
    expect(result.error).toBe('disk full');
  });

  it('agent reports artifacts and usage', async () => {
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        const body = JSON.stringify({
          status: 'completed', output: 'done',
          artifacts: [{ name: 'report.pdf', type: 'application/pdf' }],
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.003, model: 'gpt-4' },
        });
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${body}'`, env);
      },
    });
    bridges.push(bridge);
    const result = await new Worker({ agent }).run({ id: 't4', prompt: 'go', teamId: 'test' });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts![0].name).toBe('report.pdf');
    expect(result.usage?.model).toBe('gpt-4');
    expect(result.usage?.costUsd).toBe(0.003);
  });
});

// ── 2. Delegation via bridge ──

describe('Bridge: delegation', () => {
  it('agent delegates 2 subtasks via curl', async () => {
    const leafAgent: Agent = {
      async execute(task) { return { status: 'completed', output: `leaf:${task.prompt}` }; },
    };
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        const res = await sh(`curl -s -X POST ${env.ROBAL_DELEGATE_URL} -H 'Content-Type: application/json' -d '{"subtasks":[{"prompt":"a"},{"prompt":"b"}]}'`, env);
        const { results } = JSON.parse(res);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output: results.join('|') })}'`, env);
      },
    });
    bridges.push(bridge);
    const wrapper: Agent = {
      async execute(task) {
        const orig = task.delegate;
        if (orig) task = { ...task, delegate: (subs) => orig(subs.map(s => ({ ...s, agent: leafAgent }))) };
        return agent.execute(task);
      },
    };
    const result = await new Worker({ agent: wrapper, maxDepth: 2 }).run({ id: 'd1', prompt: 'go', teamId: 'test' });
    expect(result.output).toBe('leaf:a|leaf:b');
  });

  it('agent gets error when delegating at max depth', async () => {
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        if (env.ROBAL_CAN_DELEGATE === 'true') {
          await sh(`curl -s -X POST ${env.ROBAL_DELEGATE_URL} -H 'Content-Type: application/json' -d '{"subtasks":[{"prompt":"x"}]}'`, env);
        }
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"depth:'${env.ROBAL_DEPTH}' canDel:'${env.ROBAL_CAN_DELEGATE}'"}'`, env);
      },
    });
    bridges.push(bridge);
    const result = await new Worker({ agent, maxDepth: 0 }).run({ id: 'd2', prompt: 'go', teamId: 'test' });
    expect(result.output).toContain('canDel:false');
  });

  it('3-level hierarchy: shell parent → JS managers → JS leaves', async () => {
    const leafAgent: Agent = {
      async execute(task) { return { status: 'completed', output: `leaf:${task.prompt}` }; },
    };
    const managerAgent: Agent = {
      async execute(task) {
        if (task.delegate) {
          const results = await task.delegate([
            { prompt: `${task.prompt}-sub1`, agent: leafAgent },
            { prompt: `${task.prompt}-sub2`, agent: leafAgent },
          ]);
          return { status: 'completed', output: `mgr[${results.join(',')}]` };
        }
        return { status: 'completed', output: `mgr-leaf:${task.prompt}` };
      },
    };
    const { agent: shellCeo, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        const res = await sh(`curl -s -X POST ${env.ROBAL_DELEGATE_URL} -H 'Content-Type: application/json' -d '{"subtasks":[{"prompt":"eng"},{"prompt":"mkt"}]}'`, env);
        const { results } = JSON.parse(res);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output: `ceo[${results.join(' | ')}]` })}'`, env);
      },
    });
    bridges.push(bridge);
    const wrapper: Agent = {
      async execute(task) {
        const orig = task.delegate;
        if (orig) task = { ...task, delegate: (subs) => orig(subs.map(s => ({ ...s, agent: managerAgent }))) };
        return shellCeo.execute(task);
      },
    };
    const result = await new Worker({ agent: wrapper, maxDepth: 3, maxWorkers: 10 }).run({ id: 'h1', prompt: 'plan', teamId: 'test' });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('ceo[');
    expect(result.output).toContain('mgr[');
    expect(result.output).toContain('leaf:eng-sub1');
    expect(result.output).toContain('leaf:mkt-sub2');
  });
});

// ── 3. Review cycle via bridge ──

describe('Bridge: review cycle', () => {
  it('reviewer rejects then approves via HTTP', async () => {
    let attempts = 0;
    const agent: Agent = {
      async execute(task) {
        attempts++;
        return { status: 'completed', output: task.feedback ? 'v2-improved' : 'v1-draft' };
      },
    };
    const reviewBridge = new AgentBridge(0);
    const port = await reviewBridge.start();
    bridges.push(reviewBridge);
    const { reviewer } = createBridgedReviewer(reviewBridge);

    const worker = new Worker({ agent, reviewer, maxCycles: 3 });
    const promise = worker.run({ id: 'r1', prompt: 'write', teamId: 'test' });

    // Reject first attempt
    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":false,"confidence":0.3,"feedback":"too short"}'`, {});

    // Approve second attempt
    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":true,"confidence":0.9,"feedback":""}'`, {});

    const result = await promise;
    expect(result.status).toBe('completed');
    expect(result.output).toBe('v2-improved');
    expect(attempts).toBe(2);
  });

  it('reviewer rejects all attempts — last output returned', async () => {
    let attempts = 0;
    const agent: Agent = {
      async execute() { attempts++; return { status: 'completed', output: `attempt-${attempts}` }; },
    };
    const reviewBridge = new AgentBridge(0);
    const port = await reviewBridge.start();
    bridges.push(reviewBridge);
    const { reviewer } = createBridgedReviewer(reviewBridge);

    const worker = new Worker({ agent, reviewer, maxCycles: 2 });
    const promise = worker.run({ id: 'r2', prompt: 'write', teamId: 'test' });

    // Reject both
    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":false,"confidence":0.2,"feedback":"nope"}'`, {});
    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":false,"confidence":0.1,"feedback":"still no"}'`, {});

    const result = await promise;
    expect(result.output).toBe('attempt-2');
    expect(attempts).toBe(2);
  });

  it('feedback from reviewer is passed to agent on retry', async () => {
    const receivedFeedback: (string | undefined)[] = [];
    const agent: Agent = {
      async execute(task) {
        receivedFeedback.push(task.feedback);
        return { status: 'completed', output: 'output' };
      },
    };
    const reviewBridge = new AgentBridge(0);
    const port = await reviewBridge.start();
    bridges.push(reviewBridge);
    const { reviewer } = createBridgedReviewer(reviewBridge);

    const worker = new Worker({ agent, reviewer, maxCycles: 3 });
    const promise = worker.run({ id: 'r3', prompt: 'go', teamId: 'test' });

    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":false,"confidence":0.3,"feedback":"add tests"}'`, {});
    await delay(50);
    await sh(`curl -s -X POST http://127.0.0.1:${port}/submit-review -H 'Content-Type: application/json' -d '{"approved":true,"confidence":0.9,"feedback":""}'`, {});

    await promise;
    expect(receivedFeedback[0]).toBeUndefined(); // first attempt, no feedback
    expect(receivedFeedback[1]).toBe('add tests'); // second attempt, got feedback
  });
});

// ── 4. Multi-team pipelines ──

describe('Bridge: pipelines', () => {
  it('linear pipeline: shell agent A → shell agent B', async () => {
    const { agent: a1, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"from-A"}'`, env);
      },
    });
    bridges.push(b1);
    const { agent: a2, bridge: b2 } = await createBridgedAgent({
      run: async (_task, env) => {
        const taskJson = await sh(`curl -s ${env.ROBAL_TASK_URL}`, env);
        const t = JSON.parse(taskJson);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output: `B-received:${t.prompt}` })}'`, env);
      },
    });
    bridges.push(b2);

    const result = await new Orchestrator({
      teams: { a: { agent: a1 }, b: { agent: a2 } },
      channels: [{ from: 'a', to: 'b' }],
    }).pipeline('a', 'start');

    expect(result.output).toBe('B-received:from-A');
  });

  it('3-stage pipeline: shell → JS → shell', async () => {
    const { agent: shell1, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"raw-data"}'`, env);
      },
    });
    bridges.push(b1);

    const jsAgent: Agent = {
      async execute(task) { return { status: 'completed', output: `processed:${task.prompt}` }; },
    };

    const { agent: shell2, bridge: b2 } = await createBridgedAgent({
      run: async (_task, env) => {
        const taskJson = await sh(`curl -s ${env.ROBAL_TASK_URL}`, env);
        const t = JSON.parse(taskJson);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output: `final:${t.prompt}` })}'`, env);
      },
    });
    bridges.push(b2);

    const result = await new Orchestrator({
      teams: { ingest: { agent: shell1 }, transform: { agent: jsAgent }, export: { agent: shell2 } },
      channels: [{ from: 'ingest', to: 'transform' }, { from: 'transform', to: 'export' }],
    }).pipeline('ingest', 'go');

    expect(result.output).toBe('final:processed:raw-data');
  });

  it('pipeline with gate that blocks', async () => {
    const { agent: a1, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"short"}'`, env);
      },
    });
    bridges.push(b1);
    const { agent: a2, bridge: b2 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"should not reach"}'`, env);
      },
    });
    bridges.push(b2);

    const events: string[] = [];
    const result = await new Orchestrator({
      teams: { a: { agent: a1 }, b: { agent: a2 } },
      channels: [{ from: 'a', to: 'b', gate: (output) => output.length > 100 }],
      onEvent: (e) => events.push(e.type),
    }).pipeline('a', 'go');

    expect(result.output).toBe('short'); // gate blocked, returned A's output
    expect(events).toContain('channel:gated');
  });

  it('pipeline with transform', async () => {
    const { agent: a1, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"hello world"}'`, env);
      },
    });
    bridges.push(b1);
    const jsAgent: Agent = {
      async execute(task) { return { status: 'completed', output: task.prompt }; },
    };

    const result = await new Orchestrator({
      teams: { a: { agent: a1 }, b: { agent: jsAgent } },
      channels: [{ from: 'a', to: 'b', transform: (o) => o.toUpperCase() }],
    }).pipeline('a', 'go');

    expect(result.output).toBe('HELLO WORLD');
  });

  it('fan-out: one source to two sinks in parallel', async () => {
    const { agent: src, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"source-data"}'`, env);
      },
    });
    bridges.push(b1);
    const sink1: Agent = { async execute(task) { return { status: 'completed', output: `s1:${task.prompt}` }; } };
    const sink2: Agent = { async execute(task) { return { status: 'completed', output: `s2:${task.prompt}` }; } };

    const result = await new Orchestrator({
      teams: { source: { agent: src }, sink1: { agent: sink1 }, sink2: { agent: sink2 } },
      channels: [{ from: 'source', to: 'sink1' }, { from: 'source', to: 'sink2' }],
    }).pipeline('source', 'go');

    expect(result.output).toContain('s1:source-data');
    expect(result.output).toContain('s2:source-data');
  });

  it('pipeline stops on failure', async () => {
    const { agent: failShell, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"failed","error":"crash"}'`, env);
      },
    });
    bridges.push(b1);
    const neverAgent: Agent = { async execute() { throw new Error('should not run'); } };

    const result = await new Orchestrator({
      teams: { a: { agent: failShell }, b: { agent: neverAgent } },
      channels: [{ from: 'a', to: 'b' }],
    }).pipeline('a', 'go');

    expect(result.status).toBe('failed');
    expect(result.error).toBe('crash');
  });
});

// ── 5. Parallel execution ──

describe('Bridge: parallel', () => {
  it('runs 3 shell agents in parallel', async () => {
    const agents: { agent: Agent; bridge: AgentBridge }[] = [];
    for (let i = 0; i < 3; i++) {
      const { agent, bridge } = await createBridgedAgent({
        run: async (_task, env) => {
          await delay(10 + Math.random() * 20); // simulate varying latency
          await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"agent-${env.ROBAL_TEAM_ID}"}'`, env);
        },
      });
      agents.push({ agent, bridge });
      bridges.push(bridge);
    }

    const orc = new Orchestrator({
      teams: {
        t0: { agent: agents[0].agent },
        t1: { agent: agents[1].agent },
        t2: { agent: agents[2].agent },
      },
    });

    const start = Date.now();
    const results = await orc.parallel([
      { teamId: 't0', prompt: 'a' },
      { teamId: 't1', prompt: 'b' },
      { teamId: 't2', prompt: 'c' },
    ]);
    const elapsed = Date.now() - start;

    expect(results.every(r => r.status === 'completed')).toBe(true);
    expect(results[0].output).toBe('agent-t0');
    expect(results[1].output).toBe('agent-t1');
    expect(results[2].output).toBe('agent-t2');
    // Should run in parallel, not sequentially (3 × ~30ms would be ~90ms sequential)
    expect(elapsed).toBeLessThan(200);
  });

  it('parallel handles mixed success and failure', async () => {
    const okAgent: Agent = { async execute() { return { status: 'completed', output: 'ok' }; } };
    const { agent: failShell, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"failed","error":"nope"}'`, env);
      },
    });
    bridges.push(bridge);

    const results = await new Orchestrator({
      teams: { good: { agent: okAgent }, bad: { agent: failShell } },
    }).parallel([
      { teamId: 'good', prompt: 'a' },
      { teamId: 'bad', prompt: 'b' },
    ]);

    expect(results[0].status).toBe('completed');
    expect(results[1].status).toBe('failed');
  });
});

// ── 6. Events ──

describe('Bridge: event observability', () => {
  it('emits full event lifecycle for pipeline with review', async () => {
    const agent: Agent = {
      async execute(task) {
        return { status: 'completed', output: task.feedback ? 'fixed' : 'draft' };
      },
    };
    const reviewer: Reviewer = {
      async review(_task, output) {
        if (output.output === 'draft') return { approved: false, confidence: 0.3, feedback: 'fix it' };
        return { approved: true, confidence: 0.9, feedback: '' };
      },
    };
    const { agent: shell2, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"final"}'`, env);
      },
    });
    bridges.push(bridge);

    const events: string[] = [];
    const result = await new Orchestrator({
      teams: {
        dev: { agent, reviewer, maxCycles: 3 },
        deploy: { agent: shell2 },
      },
      channels: [{ from: 'dev', to: 'deploy' }],
      onEvent: (e) => events.push(e.type),
    }).pipeline('dev', 'build');

    expect(result.output).toBe('final');
    expect(events).toContain('task:started');
    expect(events).toContain('review');
    expect(events).toContain('task:completed');
    expect(events).toContain('channel:routed');
    expect(events).toContain('worker');
  });
});
