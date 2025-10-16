// translate.js
const { TranslationServiceClient } = require('@google-cloud/translate').v3;

const projectId = process.env.GCP_PROJECT_ID;
const location = process.env.GCP_TRANSLATE_LOCATION || 'global';

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

async function detectAndTranslate(text, target = 'en') {
  if (!text || typeof text !== 'string') {
    return { originalLanguage: null, translatedText: text };
  }

  const parent = `projects/${projectId}/locations/${location}`;

  try {
    // 1) Detect language
    const detectRequest = {
      parent,
      content: text,
      // mimeType optional: 'text/plain'
    };
    const [detectResponse] = await client.detectLanguage(detectRequest);
    const detected = (detectResponse.languages && detectResponse.languages[0]) || null;
    const languageCode = detected?.languageCode || null;
    const confidence = detected?.confidence || null;

    // If already english, we can short circuit
    if (languageCode === 'en' || languageCode === 'en-US') {
      return { originalLanguage: languageCode, confidence, translatedText: text };
    }

    // 2) Translate to English
    const translateRequest = {
      parent,
      contents: [text],
      mimeType: 'text/plain',
      targetLanguageCode: target,
      sourceLanguageCode: languageCode || undefined, // optional
    };

    const [translateResponse] = await client.translateText(translateRequest);
    const translated = (translateResponse.translations && translateResponse.translations[0]?.translatedText) || text;

    return { originalLanguage: languageCode, confidence, translatedText: translated };
  } catch (err) {
    console.error('Translation error:', err.message || err);
    // Fail gracefully — return original text as translation
    return { originalLanguage: null, translatedText: text, error: err.message };
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
