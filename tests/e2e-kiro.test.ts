import { describe, it, expect, afterEach } from 'vitest';
import { execSync, spawn } from 'child_process';
import { createBridgedAgent, AgentBridge, createBridgedReviewer } from '../src/bridge';
import { Orchestrator, Worker } from '../src';
import type { Agent } from '../src';

const hasKiro = (() => { try { execSync('which kiro-cli', { stdio: 'pipe' }); return true; } catch { return false; } })();

const bridges: AgentBridge[] = [];
afterEach(async () => { for (const b of bridges) await b.stop(); bridges.length = 0; });

function sh(cmd: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', cmd], { env: { ...process.env, ...env }, timeout: 120_000 });
    let out = '';
    child.stdout.on('data', (d) => out += d);
    child.stderr.on('data', () => {});
    child.on('close', (code) => code === 0 ? resolve(out) : reject(new Error(`exit ${code}`)));
  });
}

function kiro(prompt: string, env: Record<string, string> = {}): Promise<string> {
  const escaped = prompt.replace(/"/g, '\\"');
  return sh(`echo "${escaped}" | kiro-cli chat --no-interactive --trust-all-tools`, env);
}

describe('E2E: kiro-cli as agent', () => {
  it.skipIf(!hasKiro)('kiro-cli executes task and submits result via bridge', async () => {
    const { agent, bridge } = await createBridgedAgent({
      timeoutMs: 60_000,
      run: async (task, env) => {
        await kiro(
          `${task.prompt}\nAfter you have the answer, run: curl -s -X POST ${env.ROBAL_RESULT_URL} -H "Content-Type: application/json" -d '{"status":"completed","output":"YOUR_ANSWER"}'\nReplace YOUR_ANSWER with your answer. Run the curl.`,
          env,
        );
      },
    });
    bridges.push(bridge);

    const result = await new Worker({ agent, timeoutMs: 60_000 })
      .run({ id: 'k1', prompt: 'What is 7 * 8? Just the number.', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('56');
  }, 90_000);

  it.skipIf(!hasKiro)('kiro-cli delegates to child agents via bridge', async () => {
    const leafAgent: Agent = {
      async execute(task) {
        const answer = task.prompt.includes('France') ? 'Paris' : 'Tokyo';
        return { status: 'completed', output: answer };
      },
    };

    const { agent: mgrAgent, bridge } = await createBridgedAgent({
      timeoutMs: 120_000,
      run: async (task, env) => {
        // Turn 1: delegate
        await kiro(
          `Run this command and show me the output: curl -s -X POST ${env.ROBAL_DELEGATE_URL} -H "Content-Type: application/json" -d '{"subtasks":[{"prompt":"Capital of France?"},{"prompt":"Capital of Japan?"}]}'`,
          env,
        );
        // Turn 2: submit result
        await kiro(
          `Run this command: curl -s -X POST ${env.ROBAL_RESULT_URL} -H "Content-Type: application/json" -d '{"status":"completed","output":"Capitals found: Paris and Tokyo"}'`,
          env,
        );
      },
    });
    bridges.push(bridge);

    const wrapper: Agent = {
      async execute(task) {
        const orig = task.delegate;
        if (orig) task = { ...task, delegate: (subs) => orig(subs.map(s => ({ ...s, agent: leafAgent }))) };
        return mgrAgent.execute(task);
      },
    };

    const result = await new Worker({ agent: wrapper, maxDepth: 2, timeoutMs: 120_000 })
      .run({ id: 'k2', prompt: 'Find capitals', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('Paris');
    expect(result.output).toContain('Tokyo');
  }, 180_000);

  it.skipIf(!hasKiro)('kiro-cli in a multi-team pipeline', async () => {
    // Team 1: kiro generates content
    const { agent: kiroAgent, bridge: b1 } = await createBridgedAgent({
      timeoutMs: 60_000,
      run: async (task, env) => {
        await kiro(
          `${task.prompt}\nGive a one-sentence answer. Then run: curl -s -X POST ${env.ROBAL_RESULT_URL} -H "Content-Type: application/json" -d '{"status":"completed","output":"YOUR_ANSWER"}'\nReplace YOUR_ANSWER with your sentence. Run the curl.`,
          env,
        );
      },
    });
    bridges.push(b1);

    // Team 2: JS agent transforms
    const upperAgent: Agent = {
      async execute(task) {
        return { status: 'completed', output: task.prompt.toUpperCase() };
      },
    };

    const orc = new Orchestrator({
      teams: {
        writer: { agent: kiroAgent },
        formatter: { agent: upperAgent },
      },
      channels: [{ from: 'writer', to: 'formatter' }],
    });

    const result = await orc.pipeline('writer', 'What color is the sky on a clear day?');

    expect(result.status).toBe('completed');
    // Kiro's answer uppercased by formatter
    expect(result.output).toMatch(/BLUE/i);
  }, 90_000);

  it.skipIf(!hasKiro)('kiro-cli with review cycle via bridge', async () => {
    let attempts = 0;
    const { agent: kiroAgent, bridge: b1 } = await createBridgedAgent({
      timeoutMs: 60_000,
      run: async (task, env) => {
        attempts++;
        const extra = task.feedback ? ` Previous feedback: ${task.feedback}. Address it.` : '';
        await kiro(
          `${task.prompt}${extra}\nGive a brief answer. Then run: curl -s -X POST ${env.ROBAL_RESULT_URL} -H "Content-Type: application/json" -d '{"status":"completed","output":"YOUR_ANSWER"}'\nReplace YOUR_ANSWER. Run the curl.`,
          env,
        );
      },
    });
    bridges.push(b1);

    // Reviewer rejects first attempt, approves second
    let reviewCount = 0;
    const reviewer = {
      async review(_task: any, output: any) {
        reviewCount++;
        if (reviewCount === 1) {
          return { approved: false, confidence: 0.3, feedback: 'Be more specific about the wavelength of light' };
        }
        return { approved: true, confidence: 0.9, feedback: '' };
      },
    };

    const result = await new Worker({ agent: kiroAgent, reviewer, maxCycles: 3, timeoutMs: 120_000 })
      .run({ id: 'k4', prompt: 'Why is the sky blue?', teamId: 'test' });

    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
    expect(attempts).toBe(2);
    expect(reviewCount).toBe(2);
  }, 180_000);
});
