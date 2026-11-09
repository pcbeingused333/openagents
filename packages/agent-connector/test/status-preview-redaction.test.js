'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const wsl = require('../src/wsl');
let spawned;
wsl.spawn = () => {
  const p = new EventEmitter();
  p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = new EventEmitter();
  p.stdin.written = []; p.stdin.write = (s) => { p.stdin.written.push(s); };
  p.stdin.end = () => {}; p.kill = () => {}; spawned = p; return p;
};
const TOKEN = 'synthetic-opaque-credential-for-preview-tests';
const payload = (n, secret) => 'x '.repeat(n).slice(0, n - 12) + (secret ? TOKEN : 'ordinary-long-input-for-preview-tests');
const tick = () => new Promise((r) => setImmediate(r));
function make(name) {
  const Adapter = require(`../src/adapters/${name}`);
  const adapter = new Adapter({ workspaceId: 'preview-test', channelName: 'general',
    agentName: name, token: TOKEN, agentEnv: {}, workingDir: process.cwd() });
  const sent = [];
  adapter.client = { sendMessage: async (ws, ch, token, content, options) => {
    assert.equal(token, TOKEN); if (options.messageType === 'status') sent.push(content);
  } };
  adapter._log = () => {}; adapter._saveSessions = () => {}; adapter._resetIdleTimer = () => {};
  adapter._resolveToNodeCmd = () => null; adapter._titledSessions.add('general');
  return { adapter, sent };
}
const safe = (s, n) => s.replaceAll(TOKEN, '[REDACTED]').slice(0, n);
for (const secret of [true, false]) {
  const label = secret ? 'masks credential across cutoff' : 'preserves ordinary preview';
  it(`Codex stdout ${label}`, async () => {
    const { adapter, sent } = make('codex');
    const prompt = `execute ${TOKEN}`;
    const run = adapter._spawnCodex(['codex'], {}, 'general', prompt);
    const p = spawned, command = payload(200, secret);
    p.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: {
      type: 'command_execution', command, exit_code: 0 } }) + '\n'));
    await tick(); p.emit('exit', 0); p.emit('close', 0); await run;
    assert.deepEqual(p.stdin.written, [prompt], 'execution input stays intact');
    assert.deepEqual(sent, [`**Running:** \`${safe(command, 200)}\` (exit 0)`]);
  });
  for (const name of ['claude', 'copilot']) for (const shape of ['content', 'json', 'string']) {
    it(`${name} ${shape} ${label}`, async () => {
      const { adapter, sent } = make(name);
      const limit = name === 'claude' ? (shape === 'content' ? 100 : 150) : (shape === 'content' ? 80 : 120);
      const raw = payload(limit - (shape === 'json' ? 9 : 0), secret);
      const input = shape === 'content' ? { content: raw } : shape === 'json' ? { data: raw } : raw;
      if (name === 'claude') {
        const pp = adapter._spawnPersistentProc('general', ['claude'], {});
        spawned.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: {
          content: [{ type: 'tool_use', name: 'Tool', input }] } }) + '\n'));
        await pp.pendingLines; spawned.emit('exit', 0); spawned.emit('close', 0);
        assert.equal(pp.awaitingToolResult, true); assert.equal(pp.hasToolUseSinceLastText, true);
      } else await adapter.sendStatus('general', adapter._describeTool({ tool: 'Tool', input }));
      assert.deepEqual(sent, [`Tool › ${safe(shape === 'json' ? JSON.stringify(input) : raw, limit)}`]);
    });
  }
  it(`Gemini stdout ${label}`, async () => {
    const { adapter, sent } = make('gemini');
    adapter._buildGeminiCmd = () => ({ cmd: ['gemini'] });
    const run = adapter._handleMessage({ content: 'do the work', sessionId: 'general' });
    await tick(); const p = spawned, input = { data: payload(141, secret) };
    p.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'tool_use', tool_name: 'Tool', parameters: input }) + '\n'));
    await tick(); p.emit('exit', 0); p.emit('close', 0); await run;
    assert.ok(sent.includes(`Tool › ${safe(JSON.stringify(input), 150)}`));
  });
  it(`OpenCode event handler ${label}`, async () => {
    const { adapter, sent } = make('opencode');
    const event = { type: 'tool_use', tool: { name: 'Tool', input: payload(1000, secret) } };
    const original = structuredClone(event);
    await adapter._handleStreamEvent(event, 'general'); assert.deepEqual(event, original);
    assert.deepEqual(sent, [`**Using tool:** \`Tool\`\n\`\`\`\n${safe(event.tool.input, 1000)}\n\`\`\``]);
  });
}

// Exercise stream producers through their real adapter subprocess handlers.
for (const secret of [true, false]) {
  for (const name of ['amp', 'aider', 'cline', 'codebuddy', 'commandcode']) {
    it(`${name} stdout preserves execution and ${secret ? 'redacts crossing credential' : 'ordinary preview'}`, async () => {
      const { adapter, sent } = make(name);
      adapter._spawnableCmd = (bin, args) => [bin, ...args];
      const prompt = `execute ${TOKEN}`;
      const limit = { amp: 200, aider: 300, cline: 160, codebuddy: 150, commandcode: 160 }[name];
      let raw = payload(limit, secret), event, run;
      if (name === 'amp') {
        raw = payload(191, secret);
        event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Tool', input: { data: raw } }] } };
        run = adapter._spawnAmp(['amp'], prompt, 'general');
      } else if (name === 'aider') {
        raw = 'Running ' + payload(292, secret); event = raw;
        run = adapter._spawnAider(['aider'], 'general');
      } else if (name === 'cline') {
        event = { type: 'agent_event', event: { type: 'content_start', contentType: 'tool', toolName: 'run_commands', input: { command: raw } } };
        run = adapter._runCline('general', 'cline', [], process.cwd());
      } else if (name === 'codebuddy') {
        event = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Tool', input: { command: raw } }] } };
        run = adapter._runCodeBuddy('general', 'codebuddy', [], process.cwd(), prompt);
      } else {
        event = { type: 'event', event: { type: 'tool_running', toolName: 'shell', description: raw } };
        run = adapter._runCommandCode('general', 'commandcode', [], process.cwd(), prompt);
      }
      const p = spawned;
      p.stdout.emit('data', Buffer.from((typeof event === 'string' ? event : JSON.stringify(event)) + '\n'));
      await tick(); p.emit('exit', 0); p.emit('close', 0); await run;
      assert.equal(sent.length, 1);
      if (secret) {
        assert.ok(!sent[0].includes(TOKEN.slice(0, 12)), 'no partial known credential');
        assert.match(sent[0], /\[REDACTED\]/);
      } else assert.ok(sent[0].includes('ordinary-lo'));
      if (['amp', 'codebuddy', 'commandcode'].includes(name)) {
        assert.ok(p.stdin.written.join('').includes(prompt), 'original prompt passed to CLI');
      }
    });
  }
}

for (const name of ['goose', 'antigravity']) {
  it(`${name} parser keeps accepting null options`, () => {
    const mod = require(`../src/adapters/${name}-stream`);
    const Parser = mod.GooseStreamParser || mod.AgyRunState;
    assert.doesNotThrow(() => new Parser(null));
  });
}

for (const secret of [true, false]) {
  for (const name of ['kimi', 'pi', 'goose', 'antigravity', 'kiro', 'openworker']) {
    it(`${name} stream preview ${secret ? 'masks crossing credential' : 'preserves ordinary data'}`, async () => {
      const { adapter, sent } = make(name);
      const redact = (text) => adapter._redact(text);
      const limit = name === 'kimi' ? 80 : name === 'antigravity' ? 150 : name === 'openworker' ? 200 : 160;
      const text = payload(limit, secret);
      let event, preview;
      if (name === 'kimi') {
        const { interpretKimiMessage } = require('../src/adapters/kimi-stream');
        event = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'Tool', arguments: JSON.stringify({ command: text }) } }] };
        preview = interpretKimiMessage(event, redact)[0].preview;
      } else if (name === 'pi') {
        const { PiStreamParser } = require('../src/adapters/pi-stream');
        event = { type: 'tool_execution_start', toolName: 'bash', args: { command: text } };
        preview = new PiStreamParser({ redact }).push(JSON.stringify(event) + '\n')[0].preview;
      } else if (name === 'goose') {
        const { GooseStreamParser } = require('../src/adapters/goose-stream');
        event = { type: 'message', message: { role: 'assistant', content: [{ type: 'toolRequest', toolCall: { status: 'success', value: { name: 'Tool', arguments: { command: text } } } }] } };
        const events = new GooseStreamParser({ redact }).feed(JSON.stringify(event) + '\n');
        preview = events[0].summary;
        await adapter._dispatchEvent('general', events[0], {});
        assert.ok(sent[0].includes(preview));
      } else if (name === 'antigravity') {
        const { AgyRunState } = require('../src/adapters/antigravity-stream');
        event = { event: 'step_update', step_update: { step_type: 'tool', tool_info: { name: 'Tool', parameters: { data: payload(141, secret) } } } };
        preview = new AgyRunState({ redact }).consume(event)[0].preview;
      } else if (name === 'kiro') {
        const { interpretUpdate } = require('../src/adapters/kiro-runtime');
        event = { update: { sessionUpdate: 'tool_call', title: text } };
        preview = interpretUpdate(event, [TOKEN]).label;
      } else {
        const { promptSummary } = require('../src/adapters/openworker-runtime');
        event = { kind: 'prompt', prompt: 'question', data: { question: text } };
        preview = promptSummary(event, redact);
      }
      if (secret) {
        assert.ok(!preview.includes(TOKEN.slice(0, 12)), 'no partial known credential');
        assert.ok(preview.includes(name === 'pi' ? '***' : '[REDACTED]'));
      } else assert.ok(preview.includes('ordinary-lo'));
      assert.ok(JSON.stringify(event).includes(secret ? TOKEN : 'ordinary-long-input'), 'original event preserved');
    });
  }
  for (const kind of ['progress', 'notification']) {
    it(`Goose ${kind} ${secret ? 'masks crossing credential' : 'preserves ordinary status'}`, async () => {
      const { adapter, sent } = make('goose');
      const text = payload(280, secret);
      await adapter._dispatchEvent('general', { kind, text }, {});
      assert.equal(sent[0], safe(text, 280) + (!secret && kind === 'progress' ? '…' : ''));
    });
  }
  it(`Pi tool result ${secret ? 'masks crossing credential' : 'preserves original result'}`, () => {
    const { adapter } = make('pi');
    const { PiStreamParser } = require('../src/adapters/pi-stream');
    const text = payload(160, secret);
    const event = { type: 'tool_execution_end', toolName: 'bash', result: { content: [{ type: 'text', text }] } };
    const out = new PiStreamParser({ redact: (s) => adapter._redact(s) }).push(JSON.stringify(event) + '\n')[0];
    assert.equal(out.preview, text.replaceAll(TOKEN, '***').slice(0, 160) + (secret ? '' : '…'));
    assert.equal(event.result.content[0].text, text);
  });
}
