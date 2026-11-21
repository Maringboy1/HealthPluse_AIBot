const PRIMARY_VOICE = "en-IN-NeerjaExpressiveNeural";
const FALLBACK_VOICE = "en-IN-NeerjaNeural";
const MAX_TEXT_LENGTH = 1600;

function setHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function cleanForSpeech(text) {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[-*#>]+\s*/gm, " ")
    .replace(/[*`~_|]/g, " ")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function synthesize(text, voice) {
  const { EdgeTTS } = await import("edge-tts-universal");
  const tts = new EdgeTTS(text, voice, {
    rate: "-4%",
    pitch: "+0Hz",
    volume: "+0%"
  });
  const result = await tts.synthesize();
  return Buffer.from(await result.audio.arrayBuffer());
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      online: true,
      provider: "edge-tts",
      primaryVoice: PRIMARY_VOICE,
      fallbackVoice: FALLBACK_VOICE
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const rawText = typeof req.body?.text === "string" ? req.body.text : "";
  const text = cleanForSpeech(rawText);

  if (!text || text.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: "The text is empty or too long." });
    return;
  }

  try {
    const audio = await synthesize(text, PRIMARY_VOICE);
    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(audio);
    return;
  } catch (primaryError) {
    console.error(`${PRIMARY_VOICE} failed:`, primaryError.message);
  }

  try {
    const audio = await synthesize(text, FALLBACK_VOICE);
    res.status(200);
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Content-Length", audio.length);
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(audio);
  } catch (fallbackError) {
    console.error(`${FALLBACK_VOICE} failed:`, fallbackError.message);
    res.status(503).json({ error: "Speech service is temporarily unavailable." });
  }
};
