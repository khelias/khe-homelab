const express = require('express');

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const PORT = Number(process.env.PORT) || 3000;

if (!API_KEY) {
  console.error('FATAL: GEMINI_API_KEY environment variable is required');
  process.exit(1);
}

const UPSTREAM = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;

const app = express();

// Accept JSON bodies regardless of Content-Type (frontend historically omitted header)
app.use(express.json({ limit: '1mb', type: '*/*' }));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

const UPSTREAM_TIMEOUT_MS = 115_000; // slightly under nginx proxy_read_timeout (120s)

app.post('/gemini', async (req, res) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: controller.signal,
    });
    const data = await upstream.json();
    if (!upstream.ok) {
      console.error('Gemini API error:', upstream.status, data?.error?.message || data);
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Upstream Gemini API error',
      });
    }
    res.json(data);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.error('Gemini upstream timeout');
      return res.status(504).json({ error: 'Upstream timeout' });
    }
    console.error('Proxy error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    clearTimeout(timer);
  }
});

app.listen(PORT, () => {
  console.log(`adventure-proxy listening on :${PORT} (model=${MODEL})`);
});
