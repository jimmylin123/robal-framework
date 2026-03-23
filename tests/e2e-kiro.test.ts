import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { createAgent, AgentServer } from '../src/server';
import { Orchestrator, Worker } from '../src';
import type { Agent } from '../src';

const hasKiro = (() => { try { execSync('which kiro-cli', { stdio: 'pipe' }); return true; } catch { return false; } })();
const KIRO = 'kiro-cli chat --no-interactive --trust-all-tools';

const bridges: AgentServer[] = [];
afterEach(async () => { for (const b of bridges) await b.stop(); bridges.length = 0; });

describe('E2E: kiro-cli as agent', () => {
  it.skipIf(!hasKiro)('kiro-cli executes task and submits result', async () => {
    const { agent, bridge } = await createAgent({ command: KIRO, timeoutMs: 90_000 });
    bridges.push(bridge);

    const result = await new Worker({ agent, timeoutMs: 90_000 })
      .run({ id: 'k1', prompt: 'What is 7 * 8? Just the number.', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('56');
  }, 120_000);

  it.skipIf(!hasKiro)('kiro-cli delegates to child agents', async () => {
    const leafAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: task.prompt.includes('France') ? 'Paris' : 'Tokyo' };
      },
    };

    const { agent: kiroAgent, bridge } = await createAgent({ command: KIRO, timeoutMs: 120_000 });
    bridges.push(bridge);

    const wrapper: Agent = {
      async execute(task) {
        const orig = task.delegate;
        if (orig) task = { ...task, delegate: (subs) => orig(subs.map(s => ({ ...s, agent: leafAgent }))) };
        return kiroAgent.execute(task);
      },
    };

    const result = await new Worker({ agent: wrapper, maxDepth: 2, timeoutMs: 120_000 })
      .run({ id: 'k2', prompt: 'Find the capitals of France and Japan. Delegate each lookup as a subtask, then combine the results.', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output.toLowerCase()).toMatch(/paris|tokyo/);
  }, 180_000);

  it.skipIf(!hasKiro)('kiro-cli in a multi-team pipeline', async () => {
    const { agent: kiroAgent, bridge } = await createAgent({ command: KIRO, timeoutMs: 60_000 });
    bridges.push(bridge);

    const upperAgent: Agent = {
      async execute(task) { return { status: 'completed', output: task.prompt.toUpperCase() }; },
    };

    const result = await new Orchestrator({
      teams: { writer: { agent: kiroAgent }, formatter: { agent: upperAgent } },
      channels: [{ from: 'writer', to: 'formatter' }],
    }).pipeline('writer', 'What color is the sky on a clear day? One word.');

    expect(result.status).toBe('completed');
    expect(result.output).toMatch(/BLUE/i);
  }, 90_000);

  it.skipIf(!hasKiro)('kiro-cli with review cycle', async () => {
    let attempts = 0;
    const { agent: kiroAgent, bridge } = await createAgent({ command: KIRO, timeoutMs: 60_000 });
    bridges.push(bridge);

    // Wrap to count attempts
    const counted: Agent = {
      async execute(task) { attempts++; return kiroAgent.execute(task); },
    };

    let reviewCount = 0;
    const reviewer = {
      async review(_task: any, _output: any) {
        reviewCount++;
        if (reviewCount === 1) return { approved: false, confidence: 0.3, feedback: 'Be more specific' };
        return { approved: true, confidence: 0.9, feedback: '' };
      },
    };

    const result = await new Worker({ agent: counted, reviewer, maxCycles: 3, timeoutMs: 120_000 })
      .run({ id: 'k4', prompt: 'Why is the sky blue? Brief answer.', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
    expect(attempts).toBe(2);
  }, 180_000);

  it.skipIf(!hasKiro)('createAgentTeam with kiro-cli as both worker and reviewer', async () => {
    const { createAgentTeam } = await import('../src/createAgentTeam');

    const result = await createAgentTeam({
      rootAgent: KIRO,
      prompt: 'What is the largest planet in our solar system? One word answer.',
      reviewer: KIRO,
      maxCycles: 2,
      timeoutMs: 90_000,
    });

    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
  }, 240_000);
});
