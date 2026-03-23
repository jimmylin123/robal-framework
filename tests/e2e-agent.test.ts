import { describe, it, expect } from 'vitest';
import { createAgent, AgentServer } from '../src/server';
import { createAgentTeam } from '../src/createAgentTeam';
import { Orchestrator, Worker } from '../src';
import type { Agent } from '../src';

// Set ROBAL_TEST_AGENT to your agent command, e.g.:
//   ROBAL_TEST_AGENT='kiro-cli chat --no-interactive --trust-all-tools' npm test
//   ROBAL_TEST_AGENT='codex --quiet' npm test
//   ROBAL_TEST_AGENT='aider --yes' npm test
const AGENT_CMD = process.env.ROBAL_TEST_AGENT;
const skip = !AGENT_CMD;
const TIMEOUT = 120_000;

if (!AGENT_CMD) {
  console.log('Skipping agent e2e tests — set ROBAL_TEST_AGENT env var to run them.');
  console.log('Example: ROBAL_TEST_AGENT="kiro-cli chat --no-interactive --trust-all-tools" npm test');
}

describe('E2E: real agent', { concurrent: true }, () => {
  it.skipIf(skip)('executes task and submits result', async () => {
    const result = await createAgentTeam({
      rootAgent: AGENT_CMD!,
      prompt: 'What is 7 * 8? Just the number.',
      timeoutMs: TIMEOUT,
    });

    expect(result.status).toBe('completed');
    expect(result.output).toContain('56');
  }, TIMEOUT + 30_000);

  it.skipIf(skip)('delegates to child agents', async () => {
    const result = await createAgentTeam({
      rootAgent: AGENT_CMD!,
      prompt: 'Find the capitals of France and Japan. Delegate each lookup as a separate subtask.',
      availableAgents: [
        { name: 'lookup-agent', description: 'Answers factual questions', agent: AGENT_CMD! },
      ],
      maxDepth: 2,
      timeoutMs: TIMEOUT,
    });

    expect(result.status).toBe('completed');
    const lower = result.output.toLowerCase();
    expect(lower).toMatch(/paris|tokyo/);
  }, TIMEOUT * 2 + 30_000);

  it.skipIf(skip)('multi-team pipeline', async () => {
    const { agent, bridge } = await createAgent({ command: AGENT_CMD!, timeoutMs: TIMEOUT });

    const upperAgent: Agent = {
      async execute(task) { return { status: 'completed', output: task.prompt.toUpperCase() }; },
    };

    const result = await new Orchestrator({
      teams: { writer: { agent }, formatter: { agent: upperAgent } },
      channels: [{ from: 'writer', to: 'formatter' }],
    }).pipeline('writer', 'What color is the sky on a clear day? One word.');

    await bridge.stop();
    expect(result.status).toBe('completed');
    expect(result.output).toMatch(/BLUE/i);
  }, TIMEOUT + 30_000);

  it.skipIf(skip)('review cycle with agent as reviewer', async () => {
    const result = await createAgentTeam({
      rootAgent: AGENT_CMD!,
      prompt: 'What is the largest planet in our solar system? One word answer.',
      reviewer: AGENT_CMD!,
      maxCycles: 2,
      timeoutMs: TIMEOUT,
    });

    expect(result.status).toBe('completed');
    expect(result.output.length).toBeGreaterThan(0);
  }, TIMEOUT * 3 + 30_000);

  it.skipIf(skip)('self-delegation without explicit availableAgents', async () => {
    const result = await createAgentTeam({
      rootAgent: AGENT_CMD!,
      prompt: 'Compute 10+20 and 30+40 by delegating each addition as a subtask to the root agent. Combine the results.',
      maxDepth: 2,
      timeoutMs: TIMEOUT,
    });

    expect(result.status).toBe('completed');
    const output = result.output;
    expect(output).toMatch(/30|70/);
  }, TIMEOUT * 2 + 30_000);
});
