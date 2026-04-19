const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const DEFAULT_PROVIDER = process.env.DEFAULT_PROVIDER || 'claude';
const PORT = Number(process.env.PORT) || 3000;
const UPSTREAM_TIMEOUT_MS = 115_000; // slightly under nginx proxy_read_timeout (120s)

if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY) {
  console.error('FATAL: at least one of GEMINI_API_KEY or ANTHROPIC_API_KEY must be set');
  process.exit(1);
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;
const geminiUrl = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

const app = express();
app.use(express.json({ limit: '1mb', type: '*/*' }));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// Legacy endpoint used by older cached frontends. Forwards a Gemini-shaped
// request body straight through to Google and returns Gemini's raw response.
// Keep until old `app.js` bundles have aged out of browser/CDN caches.
app.post('/gemini', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({ error: 'Gemini not configured on this proxy' });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(geminiUrl(GEMINI_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Gemini upstream error',
      });
    }
    res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    console.error('proxy legacy /gemini:', err.message || err);
    res.status(500).json({ error: err.message || 'Proxy error' });
  } finally {
    clearTimeout(timer);
  }
});

app.post('/generate', async (req, res) => {
  const { prompt, schema, provider = DEFAULT_PROVIDER, systemPrompt } = req.body || {};
  if (typeof prompt !== 'string' || !prompt || typeof schema !== 'object' || !schema) {
    return res.status(400).json({ error: 'prompt (string) and schema (object) are required' });
  }
  if (provider !== 'claude' && provider !== 'gemini') {
    return res.status(400).json({ error: `unknown provider: ${provider}` });
  }
  try {
    const result = provider === 'claude'
      ? await callClaude({ prompt, schema, systemPrompt })
      : await callGemini({ prompt, schema, systemPrompt });
    console.log(`proxy ok: provider=${provider} model=${result.model}`);
    res.json({ provider, model: result.model, data: result.data });
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error(`proxy (${provider}): upstream timeout`);
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    const status = err.status || 500;
    console.error(`proxy (${provider}):`, status, err.message || err);
    res.status(status).json({ error: err.message || 'Proxy error' });
  }
});

// Game schemas were written for Gemini's responseSchema, which accepts
// uppercase type names ("OBJECT", "STRING", ...). JSON Schema (and thus
// Claude's tool input_schema) requires lowercase. Walk the schema tree and
// lowercase any `type` string values before handing to Claude.
function normalizeSchemaForClaude(node) {
  if (Array.isArray(node)) {
    return node.map(normalizeSchemaForClaude);
  }
  if (node !== null && typeof node === 'object') {
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === 'type' && typeof value === 'string') {
        out[key] = value.toLowerCase();
      } else {
        out[key] = normalizeSchemaForClaude(value);
      }
    }
    return out;
  }
  return node;
}

async function callClaude({ prompt, schema, systemPrompt }) {
  if (!anthropic) {
    const err = new Error('Claude not configured on this proxy');
    err.status = 503;
    throw err;
  }
  const createParams = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    tools: [
      {
        name: 'respond',
        description: 'Submit the structured response that matches the requested schema.',
        input_schema: normalizeSchemaForClaude(schema),
      },
    ],
    tool_choice: { type: 'tool', name: 'respond' },
    messages: [{ role: 'user', content: prompt }],
  };
  if (systemPrompt) {
    createParams.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  const message = await anthropic.messages.create(createParams, { timeout: UPSTREAM_TIMEOUT_MS });

  const toolUse = message.content.find((b) => b.type === 'tool_use');
  if (!toolUse || typeof toolUse.input !== 'object') {
    throw new Error('Claude did not emit a structured tool_use block');
  }
  return { model: CLAUDE_MODEL, data: toolUse.input };
}

async function callGemini({ prompt, schema, systemPrompt }) {
  if (!GEMINI_API_KEY) {
    const err = new Error('Gemini not configured on this proxy');
    err.status = 503;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const geminiBody = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema,
        temperature: 0.8,
      },
    };
    if (systemPrompt) geminiBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    const upstream = await fetch(geminiUrl(GEMINI_MODEL), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(geminiBody),
      signal: controller.signal,
    });
    const body = await upstream.json();
    if (!upstream.ok) {
      const err = new Error(body?.error?.message || 'Gemini upstream error');
      err.status = upstream.status;
      throw err;
    }
    const text = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('Gemini returned an empty response');
    }
    return { model: GEMINI_MODEL, data: JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}

app.listen(PORT, () => {
  const claudeInfo = anthropic ? CLAUDE_MODEL : 'disabled';
  const geminiInfo = GEMINI_API_KEY ? GEMINI_MODEL : 'disabled';
  console.log(
    `adventure-proxy listening on :${PORT} | default=${DEFAULT_PROVIDER} | claude=${claudeInfo} | gemini=${geminiInfo}`,
  );
});
