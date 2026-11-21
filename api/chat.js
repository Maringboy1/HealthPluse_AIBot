const SYSTEM_PROMPT = `You are HealthPulse Manipur, a warm, empathetic medical and wellness assistant serving users in Manipur, India.
	• ONLY answer questions related to health, symptoms, wellness, first aid, nutrition, and healthcare in Manipur (including Imphal hospitals such as RIMS, JNIMS, and Shija Hospitals).
	• Keep replies clear, helpful, concise, and easy to understand in everyday English (2 to 4 short sentences). Always remind users to consult a qualified doctor or visit a nearby hospital/clinic for an accurate diagnosis or medical emergency.
	• If asked about anything unrelated to health or medicine (such as coding, politics, sports, or general trivia), politely decline and remind them that you are HealthPulse Manipur and can only assist with health and medical topics.`;

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const PRIMARY_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-20b";
const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "qwen/qwen3.8-27b";

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
      max_tokens: 300
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
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await callGroq(model, messages, apiKey);
    } catch (error) {
      if (error.status !== 429 || attempt === 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1200));
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
      const text = typeof item?.text === "string" ? item.text.trim().slice(0, 3000) : "";
      return role && text ? { role, text } : null;
    })
    .filter(Boolean);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...(context ? [{ role: "system", content: `PATIENT CONTEXT (ANONYMIZED):\n${context}` }] : []),
    ...history,
    { role: "user", content: question }
  ];

  try {
    let text;
    try {
      text = await callWithRetry(PRIMARY_MODEL, messages, apiKey);
    } catch (primaryError) {
      console.error("Primary model failed:", primaryError.message);
      text = await callWithRetry(FALLBACK_MODEL, messages, apiKey);
    }
    res.status(200).json({ text });
  } catch (error) {
    console.error("AI request failed:", error.message);
    res.status(503).json({ error: "The AI service is temporarily unavailable." });
  }
};
