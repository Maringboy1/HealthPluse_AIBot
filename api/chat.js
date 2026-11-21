const SYSTEM_PROMPT = `You are HealthPulse Manipur, a warm, practical medical and wellness assistant serving users in Manipur, India.
FORMAT RULES:
• Do not add a title. Start directly with the answer. Do not use markdown.
• Answer in at most 3 short sentences or 2 to 4 short bullet points. Every bullet must start with "• ".
• Be direct, friendly, and easy to read. Keep the full answer under 120 words.
• Never use asterisks, hashes, dashes as bullets, numbered lists, tables, separators, backticks, or other markdown symbols.
• End with one short line: Consult a doctor or visit a nearby hospital if symptoms worsen.
CLINIC RULES:
• Only answer health, symptoms, wellness, first aid, nutrition, medicines, and healthcare questions in Manipur, including RIMS, JNIMS, and Shija Hospitals.
• Do not diagnose. Do not invent patient details. Do not recommend a specific medicine dose.
• If asked anything unrelated to health, politely decline and remind the user that you can only help with health and medical topics.`;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const PRIMARY_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const SECONDARY_MODEL = process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-120b";
const TERTIARY_MODEL = process.env.GROQ_LAST_MODEL || "qwen/qwen3.8-27b";
const MODELS = [...new Set([PRIMARY_MODEL, SECONDARY_MODEL, TERTIARY_MODEL].filter(Boolean))];

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function callGroq(model, messages, apiKey) {
  const response = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.3,
      max_tokens: 300,
      reasoning_effort: model.startsWith("qwen/") ? "none" : "low"
    }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error(`Groq failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ""}`);
    error.status = response.status;
    throw error;
  }

  const body = await response.json();
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Groq returned an empty answer.");
  return text;
}

async function callWithRetry(model, messages, apiKey) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await callGroq(model, messages, apiKey);
    } catch (error) {
      const retryable = error.status === 429 || error.status >= 500;
      if (!retryable || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)));
    }
  }
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      online: Boolean(process.env.GROQ_API_KEY),
      provider: "groq",
      model: PRIMARY_MODEL
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.status(503).json({ error: "AI service is not configured." });
    return;
  }

  const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
  const context = typeof req.body?.context === "string" ? req.body.context.trim().slice(0, 8000) : "";
  const rawHistory = Array.isArray(req.body?.history) ? req.body.history : [];

  if (!question || question.length > 4000 || rawHistory.length > 12) {
    res.status(400).json({ error: "The message or conversation context is invalid." });
    return;
  }

  const history = rawHistory
    .map((item) => {
      const role = item?.role === "user" ? "user" : item?.role === "assistant" ? "assistant" : null;
      const rawText = typeof item?.text === "string" ? item.text : typeof item?.content === "string" ? item.content : "";
      const content = rawText.trim().slice(0, 3000);
      return role && content ? { role, content } : null;
    })
    .filter(Boolean);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: `PATIENT CONTEXT (ANONYMIZED):\n${context}` }] : []),
    ...history,
    { role: "user", content: question }
  ];

  const failures = [];
  for (const model of MODELS) {
    try {
      const text = await callWithRetry(model, messages, apiKey);
      res.status(200).json({ text });
      return;
    } catch (error) {
      console.error(`Groq model ${model} failed:`, error.message);
      failures.push(`${model}: ${error.message}`);
    }
  }
  console.error("All Groq models failed:", failures.join(" | "));
  res.status(503).json({ error: "The AI service is temporarily unavailable." });
};
