// openai_functions.js
const OpenAI = require("openai");
const prompts = require("./prompts");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { execSync } = require("child_process");

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
 * Fetch the URL for a WhatsApp media file (using media ID)
 * @param {string} mediaId - The ID of the media from the WhatsApp message
 * @returns {Promise<string>} - Temporary signed URL to download the media
 */
async function getMediaUrl(mediaId) {
  try {
    const url = `https://graph.facebook.com/v21.0/${mediaId}`;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    return response.data.url;
  } catch (err) {
    console.error("❌ Failed to get media URL:", err.response?.data || err.message);
    throw err;
  }
}

/**
 * Download a WhatsApp media file from its signed URL
 * @param {string} mediaUrl - The URL from getMediaUrl()
 * @returns {Promise<Buffer>} - Audio data as a Buffer
 */
async function downloadMediaFile(mediaUrl) {
  try {
    const response = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}` }
    });
    return Buffer.from(response.data);
  } catch (err) {
    console.error("❌ Failed to download media file:", err.message);
    throw err;
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
    let tempPath = path.join(__dirname, filename);
    if (Buffer.isBuffer(fileData)) {
      fs.writeFileSync(tempPath, fileData);
    } else {
      tempPath = fileData;
    }

    const wavPath = tempPath.replace(/\.\w+$/, ".wav");

    // Convert to WAV
    execSync(`ffmpeg -y -i "${tempPath}" -ar 16000 -ac 1 "${wavPath}"`);

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(wavPath),
      model: "whisper-1"
    });

    // Clean up
    fs.unlinkSync(tempPath);
    fs.unlinkSync(wavPath);

    return transcription.text || null;
  } catch (err) {
    console.error("❌ Whisper transcription error:", err.message || err);
    return null;
  }
}

/**
 * Handle a voice note end-to-end (Meta → download → Whisper)
 * @param {string} mediaId - WhatsApp media ID for the voice note
 */
async function handleVoiceNote(mediaId) {
  console.log(`🎵 Voice note received: ${mediaId}`);
  try {
    const mediaUrl = await getMediaUrl(mediaId);
    const audioBuffer = await downloadMediaFile(mediaUrl);
    const transcript = await transcribeVoiceNote(audioBuffer, "voice.ogg");
    console.log("📝 Transcribed VN:", transcript || "No text detected");
    return transcript;
  } catch (err) {
    console.error("❌ Failed to process voice note:", err.message);
    return null;
  }
}

module.exports = {
  getResponses,
  transcribeVoiceNote,
  getMediaUrl,
  downloadMediaFile,
  handleVoiceNote
};