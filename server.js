/**
 * OmniProxy - Lightweight OpenAI-compatible AI Gateway for PrepLOR
 * ----------------------------------------------------------------
 * Routes to free AI providers: Groq → Together.ai → Mistral → OpenRouter (free)
 * Uses only Express + node-fetch (~25MB RAM) — works on Render free tier.
 *
 * Authentication: Set OMNIPROXY_API_KEY env var. PHP sends it as Bearer token.
 * PrepLOR PHP calls: POST /v1/chat/completions  (same as OpenAI API format)
 */

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OMNIPROXY_API_KEY || process.env.OMNIROUTE_API_KEY || "";

// ── Free provider chain (tried in order, first success wins) ──────────────────
// Each provider needs only a free-tier API key OR is completely keyless.
// The proxy tries them in sequence; if one fails it falls to the next.
const PROVIDERS = [
  // 1. Groq — Free tier: 14,400 requests/day, fast inference
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    key: process.env.GROQ_API_KEY || "",
    model: "llama-3.3-70b-versatile",
    enabled: () => !!process.env.GROQ_API_KEY,
  },
  // 2. Together.ai — Free $25 credit on signup, OpenAI-compatible
  {
    name: "Together",
    url: "https://api.together.xyz/v1/chat/completions",
    key: process.env.TOGETHER_API_KEY || "",
    model: "meta-llama/Llama-3-8b-chat-hf",
    enabled: () => !!process.env.TOGETHER_API_KEY,
  },
  // 3. Mistral — Free tier (mistral-small-latest free for dev)
  {
    name: "Mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    key: process.env.MISTRAL_API_KEY || "",
    model: "mistral-small-latest",
    enabled: () => !!process.env.MISTRAL_API_KEY,
  },
  // 4. OpenRouter free models (google/gemma-3-27b-it:free etc.)
  {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    key: process.env.OPENROUTER_API_KEY || "",
    model: "google/gemma-3-27b-it:free",
    enabled: () => !!process.env.OPENROUTER_API_KEY,
  },
  // 5. Google Gemini — Free tier (60 req/min on flash)
  {
    name: "Gemini",
    url: null, // special handler below
    key: process.env.GEMINI_API_KEY || "",
    model: "gemini-1.5-flash",
    enabled: () => !!process.env.GEMINI_API_KEY,
    isGemini: true,
  },
];

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // No key set = open proxy (dev mode)
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
  }
  next();
}

// ── Call OpenAI-compatible provider ──────────────────────────────────────────
async function callOpenAIProvider(provider, messages, temperature, maxTokens, jsonMode) {
  const payload = {
    model: provider.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) payload.response_format = { type: "json_object" };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.key}`,
  };
  // OpenRouter needs HTTP-Referer header
  if (provider.name === "OpenRouter") {
    headers["HTTP-Referer"] = "https://preplor.scrollar.com";
    headers["X-Title"] = "PrepLOR";
  }

  const resp = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(25000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`${provider.name} HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  if (!data?.choices?.[0]?.message?.content) {
    throw new Error(`${provider.name}: empty response`);
  }
  return data;
}

// ── Call Google Gemini (different API format) ─────────────────────────────────
async function callGemini(key, model, messages, temperature, maxTokens, jsonMode) {
  const contents = [];
  let systemText = "";

  for (const msg of messages) {
    if (msg.role === "system") {
      systemText = msg.content;
    } else {
      contents.push({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      });
    }
  }

  const geminiModel = model.includes("pro") ? "gemini-1.5-pro" : "gemini-1.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`;

  const payload = {
    contents,
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };
  if (jsonMode) payload.generationConfig.responseMimeType = "application/json";

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) throw new Error(`Gemini HTTP ${resp.status}`);

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini: empty response");

  // Normalize to OpenAI format
  return {
    id: `chatcmpl-gemini-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: geminiModel,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: {
      prompt_tokens: data?.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data?.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: (data?.usageMetadata?.promptTokenCount ?? 0) + (data?.usageMetadata?.candidatesTokenCount ?? 0),
    },
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check / root
app.get("/", (req, res) => {
  res.json({
    service: "OmniProxy",
    version: "1.0.0",
    status: "running",
    description: "Lightweight OpenAI-compatible AI proxy for PrepLOR",
    endpoints: ["GET /v1/models", "POST /v1/chat/completions"],
    providers: PROVIDERS.filter((p) => p.enabled()).map((p) => p.name),
  });
});

// Models list
app.get("/v1/models", authMiddleware, (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "auto", object: "model", owned_by: "omniproxy" },
      { id: "llama-3.3-70b-versatile", object: "model", owned_by: "groq" },
      { id: "gemini-1.5-flash", object: "model", owned_by: "google" },
      { id: "mistral-small-latest", object: "model", owned_by: "mistral" },
      { id: "google/gemma-3-27b-it:free", object: "model", owned_by: "openrouter" },
    ],
  });
});

// Chat completions — main endpoint
app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const { messages = [], temperature = 0.7, max_tokens = 4096, response_format } = req.body;
  const jsonMode = response_format?.type === "json_object";
  const errors = [];

  // Try each enabled provider in sequence
  for (const provider of PROVIDERS) {
    if (!provider.enabled()) continue;

    try {
      let result;
      if (provider.isGemini) {
        result = await callGemini(provider.key, provider.model, messages, temperature, max_tokens, jsonMode);
      } else {
        result = await callOpenAIProvider(provider, messages, temperature, max_tokens, jsonMode);
      }
      // Tag which provider was used
      result._provider = provider.name;
      console.log(`[OmniProxy] ✓ ${provider.name} responded (${result.usage?.total_tokens ?? "?"} tokens)`);
      return res.json(result);
    } catch (err) {
      console.warn(`[OmniProxy] ✗ ${provider.name} failed: ${err.message}`);
      errors.push({ provider: provider.name, error: err.message });
    }
  }

  // All providers failed
  console.error("[OmniProxy] All providers failed:", errors);
  res.status(502).json({
    error: {
      message: "All AI providers failed. Configure at least one API key (GROQ_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, or OPENROUTER_API_KEY).",
      type: "omniproxy_error",
      details: errors,
    },
  });
});

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const enabledProviders = PROVIDERS.filter((p) => p.enabled()).map((p) => p.name);
  console.log(`\n🚀 OmniProxy running on port ${PORT}`);
  console.log(`📡 Active providers: ${enabledProviders.length > 0 ? enabledProviders.join(", ") : "NONE — set API keys!"}`);
  console.log(`🔒 Auth: ${API_KEY ? "Enabled (OMNIPROXY_API_KEY set)" : "Disabled (open)"}`);
  console.log(`🔗 Endpoint: http://localhost:${PORT}/v1/chat/completions\n`);
});
