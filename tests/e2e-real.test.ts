import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'child_process';
import { createBridgedAgent, AgentBridge } from '../src/bridge';
import { Orchestrator, Worker } from '../src';
import type { Agent } from '../src';

const bridges: AgentBridge[] = [];
afterEach(async () => {
  for (const b of bridges) await b.stop();
  bridges.length = 0;
});

/** Run a shell command async — doesn't block the event loop */
function sh(cmd: string, env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], { env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => stdout += d);
    child.stderr.on('data', (d) => stderr += d);
    child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `exit ${code}`)));
  });
}

describe('E2E: Shell agent via bridge protocol', () => {
  it('agent POSTs result via curl', async () => {
    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"shell: '${env.ROBAL_PROMPT}'"}'`, env);
      },
    });
    bridges.push(bridge);

    const worker = new Worker({ agent });
    const result = await worker.run({ id: 'sh-1', prompt: 'hello', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toBe('shell: hello');
  });

  it('agent delegates via curl', async () => {
    const leafAgent: Agent = {
      async execute(task) { return { status: 'completed', output: `leaf: ${task.prompt}` }; },
    };

    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        if (env.ROBAL_CAN_DELEGATE === 'true') {
          const delegateResult = await sh(
            `curl -s -X POST ${env.ROBAL_DELEGATE_URL} -H 'Content-Type: application/json' -d '{"subtasks":[{"prompt":"sub-a"},{"prompt":"sub-b"}]}'`,
            env,
          );
          const parsed = JSON.parse(delegateResult);
          const output = `parent: ${parsed.results.join(' + ')}`;
          await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output })}'`, env);
        }
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

    const worker = new Worker({ agent: wrapper, maxDepth: 2 });
    const result = await worker.run({ id: 'sh-2', prompt: 'go', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('leaf: sub-a');
    expect(result.output).toContain('leaf: sub-b');
  });

  it('agent reads task context from GET /task', async () => {
    let taskFromBridge: any = null;

    const { agent, bridge } = await createBridgedAgent({
      run: async (_task, env) => {
        const taskJson = await sh(`curl -s ${env.ROBAL_TASK_URL}`, env);
        taskFromBridge = JSON.parse(taskJson);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"ok"}'`, env);
      },
    });
    bridges.push(bridge);

    const worker = new Worker({ agent, maxDepth: 2 });
    await worker.run({ id: 'sh-3', prompt: 'do stuff', teamId: 'myteam', context: { knowledge: ['fact1'] } });

    expect(taskFromBridge.prompt).toBe('do stuff');
    expect(taskFromBridge.teamId).toBe('myteam');
    expect(taskFromBridge.canDelegate).toBe(true);
    expect(taskFromBridge.context.knowledge).toEqual(['fact1']);
  });

  it('multi-team pipeline with shell agents', async () => {
    const { agent: a1, bridge: b1 } = await createBridgedAgent({
      run: async (_task, env) => {
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '{"status":"completed","output":"step1 done"}'`, env);
      },
    });
    bridges.push(b1);

    const { agent: a2, bridge: b2 } = await createBridgedAgent({
      run: async (_task, env) => {
        const taskJson = await sh(`curl -s ${env.ROBAL_TASK_URL}`, env);
        const t = JSON.parse(taskJson);
        await sh(`curl -s -X POST ${env.ROBAL_RESULT_URL} -H 'Content-Type: application/json' -d '${JSON.stringify({ status: 'completed', output: `step2 got: ${t.prompt}` })}'`, env);
      },
    });
    bridges.push(b2);

    const orc = new Orchestrator({
      teams: { first: { agent: a1 }, second: { agent: a2 } },
      channels: [{ from: 'first', to: 'second' }],
    });

    const result = await orc.pipeline('first', 'start');
    expect(result.status).toBe('completed');
    expect(result.output).toContain('step2 got: step1 done');
  });
});
