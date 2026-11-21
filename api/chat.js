const SYSTEM_PROMPT = `You are HealthPulse Manipur, a warm, empathetic medical and wellness assistant serving users in Manipur, India.
	• ONLY answer questions related to health, symptoms, wellness, first aid, nutrition, and healthcare in Manipur (including Imphal hospitals such as RIMS, JNIMS, and Shija Hospitals).
	• Keep replies clear, helpful, concise, and easy to understand in everyday English (2 to 4 short sentences). Always remind users to consult a qualified doctor or visit a nearby hospital/clinic for an accurate diagnosis or medical emergency.
	• If asked about anything unrelated to health or medicine (such as coding, politics, sports, or general trivia), politely decline and remind them that you are HealthPulse Manipur and can only assist with health and medical topics.`;

const PRIMARY_MODEL = process.env.OPENROUTER_MODEL || "google/gemma-3-4b-it:free";
const FALLBACK_MODEL = "meta-llama/llama-3.2-3b-instruct:free";

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

async function callOpenRouter(model, messages, apiKey) {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://healthpulse-manipur.vercel.app",
      "X-Title": "HealthPulse Manipur"
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
    throw new Error(`OpenRouter failed with HTTP ${response.status}`);
  }

  const body = await response.json();
  const text = body.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter returned an empty answer.");
  return text;
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({ online: Boolean(process.env.OPENROUTER_API_KEY), model: PRIMARY_MODEL });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
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
      text = await callOpenRouter(PRIMARY_MODEL, messages, apiKey);
    } catch (primaryError) {
      console.error("Primary model failed:", primaryError.message);
      text = await callOpenRouter(FALLBACK_MODEL, messages, apiKey);
    }
    res.status(200).json({ text });
  } catch (error) {
    console.error("AI request failed:", error.message);
    res.status(503).json({ error: "The AI service is temporarily unavailable." });
  }
};
