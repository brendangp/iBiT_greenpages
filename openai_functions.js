// openai_functions.js
const OpenAI = require("openai");
const prompts = require("./prompts");
const fs = require("fs");
const path = require("path");

// Initialize OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

/**
 * Send an array of messages to OpenAI and return the assistant's response
 * @param {Array<{role: "system"|"user"|"assistant", content: string}>} messages
 * @returns {Promise<string|null>} Assistant's response or null on error
 */
async function getResponses(messages) {
  try {
    const response = await client.chat.completions.create({
      model: prompts.model_params.model,
      messages,
      max_tokens: prompts.model_params.max_tokens,
      temperature: prompts.model_params.temperature,
      n: prompts.model_params.n,
      stop: prompts.model_params.stop
    });

    // Get the raw content from OpenAI
    const rawContent = response.choices?.[0]?.message?.content || null;

    if (!rawContent) return null;

    // Ensure it is returned as JSON
    try {
      return typeof rawContent === "string" ? JSON.parse(rawContent) : rawContent;
    } catch (err) {
      console.error("❌ Failed to parse AI response as JSON:", err.message);
      // Optionally wrap it in a default object if parsing fails
      return { text: rawContent, type: "-" };
    }

  } catch (err) {
    console.error("❌ Error in OpenAI completion request:", err.message || err);
    return null;
  }
}

/**
 * Transcribe a voice note using OpenAI Whisper
 * @param {Buffer|string} fileData - The audio file as a buffer or file path
 * @param {string} [filename] - Optional: filename with extension (e.g., 'voice.ogg')
 * @returns {Promise<string|null>} Transcribed text or null on error
 */
async function transcribeVoiceNote(fileData, filename = "voice.ogg") {
  try {
    // If it's a buffer, write it temporarily
    let tempPath = null;
    if (Buffer.isBuffer(fileData)) {
      tempPath = path.join(__dirname, filename);
      fs.writeFileSync(tempPath, fileData);
    } else {
      tempPath = fileData; // assume it's a path
    }

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1"
    });

    // Remove temp file if we created one
    if (Buffer.isBuffer(fileData)) {
      fs.unlinkSync(tempPath);
    }

    return transcription.text || null;

  } catch (err) {
    console.error("❌ Whisper transcription error:", err.message || err);
    return null;
  }
}

module.exports = {
  getResponses,
  transcribeVoiceNote
};