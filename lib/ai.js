'use strict';
// Claude API client — raw fetch, zero dependencies, key never leaves the server.
// Key: ANTHROPIC_API_KEY env var, or data/config.json {"anthropicApiKey": "..."}.
// Every caller must degrade gracefully when disabled (no key / offline).

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'data', 'config.json');
const API_URL = 'https://api.anthropic.com/v1/messages';

function config() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || cfg.anthropicApiKey || '',
    model: cfg.model || 'claude-opus-4-8',        // chat + one-shot suggestions
    cheapModel: cfg.cheapModel || 'claude-haiku-4-5', // high-volume batch scripts
  };
}
function enabled() { return !!config().apiKey; }

// One Messages API call. Retries 429/529/5xx with capped backoff.
// Note: no temperature/top_p — removed on current models.
async function msg({ system, messages, tools, maxTokens = 4096, model }) {
  const cfg = config();
  if (!cfg.apiKey) {
    const e = new Error('AI is not configured — set ANTHROPIC_API_KEY or data/config.json');
    e.code = 'ai-disabled';
    throw e;
  }
  const body = { model: model || cfg.model, max_tokens: maxTokens, messages };
  if (system) body.system = system;
  if (tools && tools.length) body.tools = tools;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status === 529 || res.status >= 500) {
      if (attempt >= 4) throw new Error(`Claude API ${res.status} after ${attempt + 1} attempts`);
      const ra = Number(res.headers.get('retry-after'));
      const wait = (ra > 0 ? ra * 1000 : Math.min(30000, 1000 * 2 ** attempt));
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(`Claude API ${res.status}: ${(data.error || {}).message || 'unknown error'}`);
    return data;
  }
}

function textOf(response) {
  return (response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// Standard tool-use loop: while the model wants tools, run them and feed all
// results back in one user message. execTool(name, input) -> string|object.
async function toolLoop({ system, messages, tools, execTool, maxTokens = 4096, model, maxIters = 8 }) {
  const msgs = [...messages];
  const toolsUsed = [];
  let response;
  for (let i = 0; i < maxIters; i++) {
    response = await msg({ system, messages: msgs, tools, maxTokens, model });
    if (response.stop_reason !== 'tool_use') {
      return { response, messages: msgs, text: textOf(response), toolsUsed };
    }
    msgs.push({ role: 'assistant', content: response.content });
    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      toolsUsed.push(block.name);
      let content, isError = false;
      try { content = await execTool(block.name, block.input); }
      catch (e) { content = `Error: ${e.message}`; isError = true; }
      if (typeof content !== 'string') content = JSON.stringify(content);
      results.push({ type: 'tool_result', tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
    }
    msgs.push({ role: 'user', content: results });
  }
  return { response, messages: msgs, text: textOf(response), toolsUsed, truncated: true };
}

// Pull a JSON value out of a model reply (tolerates ``` fences and prose).
function parseJSON(text) {
  const fenced = String(text).match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = (fenced ? fenced[1] : String(text)).trim();
  const starts = [raw.indexOf('['), raw.indexOf('{')].filter((i) => i !== -1);
  if (!starts.length) throw new Error('no JSON in model reply');
  const start = Math.min(...starts);
  const closer = raw[start] === '[' ? ']' : '}';
  const end = raw.lastIndexOf(closer);
  if (end <= start) throw new Error('unterminated JSON in model reply');
  return JSON.parse(raw.slice(start, end + 1));
}

module.exports = { config, enabled, msg, textOf, toolLoop, parseJSON };
