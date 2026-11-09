'use strict';

/**
 * Status messages ("Bash › curl ...") quote the tool call the CLI is making,
 * and that call can carry this agent's own workspace token. sendStatus is the
 * single path to the channel for them, so it has to redact.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const BaseAdapter = require('../src/adapters/base');

const TOKEN = 'wsTokenValue1234567890';

function makeAdapter() {
  const sent = [];
  const calls = [];
  const adapter = new BaseAdapter({
    workspaceId: 'ws1',
    channelName: 'general',
    endpoint: 'https://example.test',
    token: TOKEN,
    agentName: 'agent',
    disabledModules: new Set(),
    agentEnv: { PROVIDER_API_KEY: 'synthetic-provider-value' },
  });
  adapter.client = { sendMessage: async (ws, channel, token, content, options) => {
    sent.push(content);
    calls.push({ ws, channel, token, content, options });
  } };
  return { adapter, sent, calls };
}

describe('BaseAdapter.sendStatus redaction', () => {
  it('masks the workspace token in a tool-call preview', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.sendStatus('ch', `Bash › curl -H "X-Workspace-Token: ${TOKEN}" https://example.test/v1`);
    assert.equal(sent.length, 1);
    assert.ok(!sent[0].includes(TOKEN), sent[0]);
    assert.match(sent[0], /\[REDACTED\]/);
  });

  it('leaves ordinary status text alone', async () => {
    const { adapter, sent } = makeAdapter();
    await adapter.sendStatus('ch', 'thinking...');
    assert.deepEqual(sent, ['thinking...']);
  });
});


describe('status redaction boundary', () => {
  it('masks opaque env credentials and repeated values without changing transport auth', async () => {
    const { adapter, sent, calls } = makeAdapter();
    await adapter.sendStatus('ch', `echo ${TOKEN} synthetic-provider-value ${TOKEN}`);
    assert.deepEqual(sent, ['echo [REDACTED] [REDACTED] [REDACTED]']);
    assert.equal(calls[0].token, TOKEN);
    assert.equal(calls[0].options.messageType, 'status');
  });

  it('honors adapter-specific known secrets', async () => {
    const { adapter, sent } = makeAdapter();
    const knownSecrets = adapter._knownSecrets.bind(adapter);
    adapter._knownSecrets = () => [...knownSecrets(), 'synthetic-sign-in-value'];
    await adapter.sendStatus('ch', 'echo synthetic-sign-in-value');
    assert.deepEqual(sent, ['echo [REDACTED]']);
  });

  it('preserves queue lifecycle metadata and does not mutate caller metadata', async () => {
    const { adapter, calls } = makeAdapter();
    const metadata = Object.freeze({ queue_id: 'q-123', queue_status: 'processed' });
    await adapter.sendStatus('ch', 'processing queued message', metadata);
    assert.deepEqual(calls[0].options.metadata, { agent_mode: adapter._mode, ...metadata });
  });

  it('does not post muted status messages', async () => {
    const { adapter, sent } = makeAdapter();
    adapter._mutedChannels.add('ch');
    await adapter.sendStatus('ch', TOKEN);
    assert.deepEqual(sent, []);
  });

  for (const [name, content, expected] of [
    ['complete credentials', `echo ${TOKEN} synthetic-provider-value`, 'echo [REDACTED] [REDACTED]'],
    ['a credential across the preview cutoff', 'x '.repeat(95) + TOKEN, 'x '.repeat(95) + '[REDACTED]'],
    ['ordinary long text', 'ordinary '.repeat(30), 'ordinary '.repeat(30).slice(0, 200)],
  ]) {
    it(`redacts queued-message metadata before truncating: ${name}`, async () => {
      const { adapter, calls } = makeAdapter();
      adapter._channelBusy.add('general');
      // Keep the real dispatch/status path, but prevent heartbeat scheduling.
      adapter._schedulePresenceHeartbeat = () => {};
      const msg = { content, senderName: 'teammate', sessionId: 'general' };
      await adapter._dispatchMessage(msg);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].options.metadata.queued_message, expected);
      assert.equal(calls[0].options.metadata.queue_id, msg._queueId);
      assert.equal(adapter._channelQueues.general[0], msg);
      assert.equal(msg.content, content, 'execution must retain the original request');
    });
  }
});
