'use strict';
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ai = require('../lib/ai');

const realFetch = globalThis.fetch;
let responses;
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  responses = [];
  globalThis.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const next = responses.shift();
    if (!next) throw new Error('mock fetch: no response queued');
    if (typeof next === 'function') return next(body);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => next };
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ANTHROPIC_API_KEY;
});

const textResp = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }] });
const toolResp = (calls) => ({
  stop_reason: 'tool_use',
  content: calls.map((c, i) => ({ type: 'tool_use', id: 't' + i, name: c.name, input: c.input })),
});

test('msg sends the right headers and returns the response', async () => {
  responses.push((body) => {
    assert.equal(body.model, 'claude-opus-4-8');
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => textResp('hi') };
  });
  const r = await ai.msg({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(ai.textOf(r), 'hi');
});

test('msg retries 529 then succeeds', async () => {
  responses.push(() => ({ ok: false, status: 529, headers: { get: () => '0' }, json: async () => ({}) }));
  responses.push(textResp('recovered'));
  const r = await ai.msg({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(ai.textOf(r), 'recovered');
});

test('msg throws ai-disabled without a key', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  // ai.enabled() also reads data/config.json — move a real one (e.g. a
  // developer's own API key) out of the way for this one assertion
  const cfgPath = path.join(__dirname, '..', 'data', 'config.json');
  const tmpPath = cfgPath + '.test-backup';
  const hadConfig = fs.existsSync(cfgPath);
  if (hadConfig) fs.renameSync(cfgPath, tmpPath);
  try {
    await assert.rejects(() => ai.msg({ messages: [] }), (e) => e.code === 'ai-disabled');
  } finally {
    if (hadConfig) fs.renameSync(tmpPath, cfgPath);
  }
});

test('toolLoop executes tools, feeds results back, returns final text', async () => {
  responses.push(toolResp([{ name: 'search', input: { q: 'gfci' } }]));
  responses.push((body) => {
    // second call must carry the assistant turn + one user message of tool_results
    const last = body.messages[body.messages.length - 1];
    assert.equal(last.role, 'user');
    assert.equal(last.content[0].type, 'tool_result');
    assert.equal(last.content[0].tool_use_id, 't0');
    assert.match(last.content[0].content, /GFRST15W/);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => textResp('Found the Hubbell.') };
  });
  const out = await ai.toolLoop({
    messages: [{ role: 'user', content: 'any gfci?' }],
    tools: [{ name: 'search', input_schema: {} }],
    execTool: (name, input) => ({ hit: 'GFRST15W', for: input.q }),
  });
  assert.equal(out.text, 'Found the Hubbell.');
  assert.deepEqual(out.toolsUsed, ['search']);
});

test('toolLoop handles parallel tool calls and tool errors in one turn', async () => {
  responses.push(toolResp([{ name: 'a', input: {} }, { name: 'b', input: {} }]));
  responses.push((body) => {
    const results = body.messages[body.messages.length - 1].content;
    assert.equal(results.length, 2); // both results in ONE user message
    assert.equal(results[1].is_error, true);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => textResp('done') };
  });
  const out = await ai.toolLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [],
    execTool: (name) => { if (name === 'b') throw new Error('boom'); return 'ok'; },
  });
  assert.equal(out.text, 'done');
});

test('toolLoop stops at maxIters and flags truncation', async () => {
  responses.push(toolResp([{ name: 'x', input: {} }]));
  responses.push(toolResp([{ name: 'x', input: {} }]));
  const out = await ai.toolLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [],
    execTool: () => 'r', maxIters: 2,
  });
  assert.ok(out.truncated);
});

test('parseJSON tolerates fences and prose', () => {
  assert.deepEqual(ai.parseJSON('Sure!\n```json\n[{"a":1}]\n```\nDone.'), [{ a: 1 }]);
  assert.deepEqual(ai.parseJSON('here: {"b":2} — that is all'), { b: 2 });
  assert.throws(() => ai.parseJSON('no json here'));
});
