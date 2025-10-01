// openai_functions.js
const OpenAI = require("openai");
const prompts = require("./prompts");

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

    // Return the content of the first choice
    return response.choices?.[0]?.message?.content || null;
  } catch (err) {
    console.error("❌ Error in OpenAI completion request:", err.message || err);
    return null;
  }
}

module.exports = {
  getResponses
};
