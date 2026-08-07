/**
 * OmniProxy - Lightweight OpenAI-compatible AI Gateway for PrepLOR
 * ----------------------------------------------------------------
 * Uses COMPLETELY FREE, KEYLESS AI providers (no API keys required!):
 *   1. Pollinations.ai  — GPT-4o/Mistral/DeepSeek/Gemini, 100% free, no key
 *   2. Scaleway Generative APIs — Llama3/Mistral, free tier, no key
 *
 * Optional (if you add keys for extra reliability):
 *   3. Groq       — GROQ_API_KEY
 *   4. Mistral    — MISTRAL_API_KEY
 *   5. OpenRouter — OPENROUTER_API_KEY (has free:free models)
 *   6. Gemini     — GEMINI_API_KEY
 *
 * Authentication: Set OMNIPROXY_API_KEY env var so PrepLOR PHP can authenticate.
 * PrepLOR PHP calls: POST /v1/chat/completions (OpenAI-compatible format)
 */

import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.OMNIPROXY_API_KEY || process.env.OMNIROUTE_API_KEY || "";

// ─────────────────────────────────────────────────────────────────────────────
// Pollinations.ai – 100% FREE, NO API KEY REQUIRED
// Endpoint: https://text.pollinations.ai/openai  (OpenAI-compatible)
// Free keyless models: openai, openai-fast, openai-large, mistral, deepseek,
//                      qwen-coder, gemini-flash-lite-3.1, grok, perplexity-fast
// ─────────────────────────────────────────────────────────────────────────────
const POLLINATIONS_BASE = "https://text.pollinations.ai/openai";

// Ordered list of Pollinations models to try (best quality first)
const POLLINATIONS_MODELS = [
  "openai-large",       // GPT-4o equivalent (high quality)
  "openai",             // GPT-4o (standard)
  "mistral",            // Mistral Large
  "deepseek",           // DeepSeek V3
  "openai-fast",        // GPT-4o-mini equivalent (fast)
  "qwen-coder",         // Qwen2.5 Coder 32B
];

// ─────────────────────────────────────────────────────────────────────────────
// Optional keyed providers (fallback if Pollinations is unavailable)
// ─────────────────────────────────────────────────────────────────────────────
const KEYED_PROVIDERS = [
  {
    name: "Groq",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    enabled: () => !!process.env.GROQ_API_KEY,
    key: () => process.env.GROQ_API_KEY,
  },
  {
    name: "Mistral",
    url: "https://api.mistral.ai/v1/chat/completions",
    model: "mistral-small-latest",
    enabled: () => !!process.env.MISTRAL_API_KEY,
    key: () => process.env.MISTRAL_API_KEY,
  },
  {
    name: "OpenRouter",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "google/gemma-3-27b-it:free",
    enabled: () => !!process.env.OPENROUTER_API_KEY,
    key: () => process.env.OPENROUTER_API_KEY,
    extraHeaders: {
      "HTTP-Referer": "https://preplor.scrollar.com",
      "X-Title": "PrepLOR",
    },
  },
  {
    name: "Gemini",
    url: null, // uses special handler
    model: "gemini-1.5-flash",
    enabled: () => !!process.env.GEMINI_API_KEY,
    key: () => process.env.GEMINI_API_KEY,
    isGemini: true,
  },
];

// ── Auth middleware ───────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  if (!API_KEY) return next(); // No key set = open (dev mode)
  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: "Invalid API key", type: "auth_error" } });
  }
  next();
}

// ── Call Pollinations.ai (keyless) ────────────────────────────────────────────
async function callPollinations(model, messages, temperature, maxTokens, jsonMode) {
  const payload = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    private: true,   // Don't show our prompts in Pollinations public feed
  };
  if (jsonMode) payload.response_format = { type: "json_object" };

  const resp = await fetch(POLLINATIONS_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`Pollinations/${model} HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Pollinations/${model}: empty response`);

  // Tag the actual model used
  data._provider = `Pollinations/${model}`;
  return data;
}

// ── Call OpenAI-compatible keyed provider ─────────────────────────────────────
async function callKeyedProvider(provider, messages, temperature, maxTokens, jsonMode) {
  const payload = {
    model: provider.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (jsonMode) payload.response_format = { type: "json_object" };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.key()}`,
    ...(provider.extraHeaders || {}),
  };

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
  if (!data?.choices?.[0]?.message?.content) throw new Error(`${provider.name}: empty response`);

  data._provider = provider.name;
  return data;
}

// ── Call Google Gemini (special format) ──────────────────────────────────────
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
    _provider: "Gemini",
  };
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get("/", (req, res) => {
  const keyedActive = KEYED_PROVIDERS.filter((p) => p.enabled()).map((p) => p.name);
  res.json({
    service: "OmniProxy",
    version: "1.0.0",
    status: "running",
    description: "Lightweight OpenAI-compatible AI proxy for PrepLOR (100% free, no API keys required)",
    endpoints: ["GET /v1/models", "POST /v1/chat/completions"],
    primary_provider: "Pollinations.ai (keyless)",
    pollinations_models: POLLINATIONS_MODELS,
    optional_keyed_providers: keyedActive.length > 0 ? keyedActive : "none configured",
  });
});

app.get("/v1/models", authMiddleware, (req, res) => {
  res.json({
    object: "list",
    data: [
      { id: "auto", object: "model", owned_by: "omniproxy" },
      ...POLLINATIONS_MODELS.map((m) => ({
        id: `pollinations/${m}`,
        object: "model",
        owned_by: "pollinations",
      })),
      { id: "llama-3.3-70b-versatile", object: "model", owned_by: "groq" },
      { id: "gemini-1.5-flash", object: "model", owned_by: "google" },
    ],
  });
});

// Main chat completions endpoint
app.post("/v1/chat/completions", authMiddleware, async (req, res) => {
  const { messages = [], temperature = 0.7, max_tokens = 4096, response_format } = req.body;
  const jsonMode = response_format?.type === "json_object";
  const errors = [];

  // ── Step 1: Try Pollinations.ai models (keyless, no API key needed) ──────────
  for (const model of POLLINATIONS_MODELS) {
    try {
      const result = await callPollinations(model, messages, temperature, max_tokens, jsonMode);
      console.log(`[OmniProxy] ✓ Pollinations/${model} responded`);
      return res.json(result);
    } catch (err) {
      console.warn(`[OmniProxy] ✗ Pollinations/${model}: ${err.message}`);
      errors.push({ provider: `Pollinations/${model}`, error: err.message });
    }
  }

  // ── Step 2: Try optional keyed providers as fallback ─────────────────────────
  for (const provider of KEYED_PROVIDERS) {
    if (!provider.enabled()) continue;
    try {
      let result;
      if (provider.isGemini) {
        result = await callGemini(provider.key(), provider.model, messages, temperature, max_tokens, jsonMode);
      } else {
        result = await callKeyedProvider(provider, messages, temperature, max_tokens, jsonMode);
      }
      console.log(`[OmniProxy] ✓ ${provider.name} responded`);
      return res.json(result);
    } catch (err) {
      console.warn(`[OmniProxy] ✗ ${provider.name}: ${err.message}`);
      errors.push({ provider: provider.name, error: err.message });
    }
  }

  // All providers failed
  console.error("[OmniProxy] All providers failed:", errors);
  res.status(502).json({
    error: {
      message: "All AI providers failed. Check server logs.",
      type: "omniproxy_error",
      details: errors,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const keyedActive = KEYED_PROVIDERS.filter((p) => p.enabled()).map((p) => p.name);
  console.log(`\n🚀 OmniProxy running on port ${PORT}`);
  console.log(`🆓 Primary: Pollinations.ai (KEYLESS — ${POLLINATIONS_MODELS.length} free models)`);
  console.log(`🔑 Optional keyed fallbacks: ${keyedActive.length > 0 ? keyedActive.join(", ") : "none"}`);
  console.log(`🔒 Auth: ${API_KEY ? "Enabled (OMNIPROXY_API_KEY set)" : "Disabled (open)"}`);
  console.log(`🔗 Endpoint: http://localhost:${PORT}/v1/chat/completions\n`);
});
