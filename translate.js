// translate.js
const { TranslationServiceClient } = require('@google-cloud/translate').v3;

const projectId = process.env.GCP_PROJECT_ID;
const location = process.env.GCP_TRANSLATE_LOCATION || 'global';

// Common short greetings/phrases that shouldn't trigger language detection
const SHORT_GREETING_CATCHES = [
  'holla', 'howzit', 'hey', 'hi', 'hello', 'yo', 'sup',
  'yo', 'ciao', 'hola', 'ola',
  'morning', 'afternoon', 'evening', 'night', 'goodnight',
  'wassup', 'whatsup', 'greetings'
];

// Initialize client: supports GOOGLE_CREDENTIALS env (JSON string) or ADC.
function createClient() {
  if (process.env.GOOGLE_CREDENTIALS) {
    // GOOGLE_CREDENTIALS should be the JSON string of the service account key
    try {
      const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      return new TranslationServiceClient({ credentials: creds, projectId });
    } catch (err) {
      console.error('Failed to parse GOOGLE_CREDENTIALS:', err.message);
      // fallthrough to default client (ADC) — will probably fail on Render if not set
    }
  }
  // If GOOGLE_APPLICATION_CREDENTIALS or ADC is configured, client will pick that up
  return new TranslationServiceClient();
}

const client = createClient();

/**
 * Check if text is too short or matches common greetings
 */
function isShortOrCommonGreeting(text) {
  if (!text) return true;
  
  const normalized = text.toLowerCase().trim();
  const wordCount = normalized.split(/\s+/).length;
  
  // Check if it's 1-2 words
  if (wordCount <= 2) {
    // Check if it matches any common greeting
    const words = normalized.split(/\s+/);
    for (const word of words) {
      if (SHORT_GREETING_CATCHES.includes(word)) {
        return true;
      }
    }
  }
  
  return false;
}

/**
 * Detect language and translate to English with confidence checking
 * @param {string} text - Original text
 * @param {string} target - Target language (default: 'en')
 * @param {number} confidenceThreshold - Minimum confidence to accept detection (default: 0.8)
 * @returns {Promise<Object>} - { originalLanguage, confidence, translatedText, shouldUseEnglish }
 */
async function detectAndTranslate(text, target = 'en', confidenceThreshold = 0.8) {
  if (!text || typeof text !== 'string') {
    return { 
      originalLanguage: 'en', 
      confidence: 1.0,
      translatedText: text,
      shouldUseEnglish: true 
    };
  }

  // Check if message is too short or a common greeting
  if (isShortOrCommonGreeting(text)) {
    console.log(`🔤 Short greeting detected: "${text}" - defaulting to English`);
    return {
      originalLanguage: 'en',
      confidence: 1.0,
      translatedText: "Hello", //Change to english so the LLM does not get confused
      shouldUseEnglish: true
    };
  }

  const parent = `projects/${projectId}/locations/${location}`;

  try {
    // 1) Detect language
    const detectRequest = {
      parent,
      content: text,
    };
    const [detectResponse] = await client.detectLanguage(detectRequest);
    const detected = (detectResponse.languages && detectResponse.languages[0]) || null;
    const languageCode = detected?.languageCode || null;
    const confidence = detected?.confidence || 0;

    console.log(`🌍 Detected language: ${languageCode} (confidence: ${confidence})`);

    // If confidence is too low, default to English
    // if (confidence < confidenceThreshold) {
    //   console.log(`⚠️ Low confidence (${confidence}) - defaulting to English`);
    //   return {
    //     originalLanguage: 'en',
    //     confidence: confidence,
    //     translatedText: text,
    //     shouldUseEnglish: true
    //   };
    // }

    // If already English, short circuit
    if (languageCode === 'en' || languageCode === 'en-US') {
      return { 
        originalLanguage: 'en', 
        confidence, 
        translatedText: text,
        shouldUseEnglish: false 
      };
    }

    // 2) Translate to target language
    const translateRequest = {
      parent,
      contents: [text],
      mimeType: 'text/plain',
      targetLanguageCode: target,
      sourceLanguageCode: languageCode || undefined,
    };

    const [translateResponse] = await client.translateText(translateRequest);
    const translated = (translateResponse.translations && translateResponse.translations[0]?.translatedText) || text;

    return { 
      originalLanguage: languageCode, 
      confidence, 
      translatedText: translated,
      shouldUseEnglish: false 
    };
  } catch (err) {
    console.error('Translation error:', err.message || err);
    return { 
      originalLanguage: 'en', 
      confidence: 0,
      translatedText: text, 
      error: err.message,
      shouldUseEnglish: true 
    };
  }
}

/**
 * Translate English text to the selected language
 * @param {string} text - English text
 * @param {string} targetLang - Language code to translate to, e.g., 'fr', 'es'
 * @returns {Promise<string>} - Translated text
 */
async function translateToSelectedLanguage(text, targetLang) {
  if (!text || !targetLang || targetLang === 'en') return text;

  const parent = `projects/${projectId}/locations/${location}`;

  try {
    const translateRequest = {
      parent,
      contents: [text],
      mimeType: 'text/plain',
      targetLanguageCode: targetLang,
      sourceLanguageCode: 'en',
    };

    const [translateResponse] = await client.translateText(translateRequest);
    const translated = (translateResponse.translations && translateResponse.translations[0]?.translatedText) || text;

    return translated;
  } catch (err) {
    console.error('Translation to selected language error:', err.message || err);
    return text; // fallback
  }
}

module.exports = { detectAndTranslate, translateToSelectedLanguage };
