const { query, longTermQuery } = require('./db');
const crypto = require('crypto');
const axios = require('axios');
const nlp = require('compromise');

// --- Helpers ---

// One-way SHA256 hash for phone numbers
function hashPhoneNumber(phone) {
  return crypto.createHash('sha256').update(phone).digest('hex');
}

// Get nearest previous Monday from a date
function getMonday(date) {
  const d = new Date(date);
  const day = d.getUTCDay(); // Sunday = 0, Monday = 1
  const diff = (day === 0 ? -6 : 1) - day; // shift Sunday to previous Monday
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// Sector lookup mapping
const sectorMapping = {
  "agri": "Agriculture, forestry, and fishing",
  "mining": "Mining and quarrying",
  "manufacturing": "Manufacturing",
  "utilities": "Electricity, gas, and water",
  "construction": "Construction",
  "trade": "Trade, catering and accommodation",
  "transport": "Transport, storage and communication",
  "finance": "Finance, real estate, and business services",
  "government": "General government services",
  "personal": "Personal services",
  "tourism": "Tourism"
};

// Parse first_message and extract structured data
function parseFirstMessage(firstMessage) {
  let data;
  try {
    data = typeof firstMessage === 'string' ? JSON.parse(firstMessage) : firstMessage;
  } catch (err) {
    console.error('Failed to parse first_message:', err);
    return { sector: null, size: null, investor_origin: null, location_details: {} };
  }

  console.log('First message data:', data);

  // Extract sector with title lookup
  const sector = data.sector ? sectorMapping[data.sector] || null : null;

  // Extract business size
  const size = data.business_size || null;

  // Extract nationality/investor origin
  const investor_origin = data.nationality || null;

  // Build location_details JSON
  const location_details = {
    location_company_hq: {
      country: data.business_hq || "",
      province: data.business_hq_province || ""
    },
    location_prl: {
      province: [],
      district_municipality: []
    },
    sphere: data.region || ""
  };

  // Only populate location_prl if location_empediment is "provincial"
  if (data.location_empediment === "provincial") {
    // Add provinces (replace "not_sure" with empty string, filter out undefined/null)
    const provinces = [data.first_province, data.second_province, data.third_province]
      .map(p => p === "not_sure" ? "" : p)
      .filter(p => p !== undefined && p !== null);
    location_details.location_prl.province = provinces;

    // Add municipalities (replace "not_sure" with empty string, filter out undefined/null)
    const municipalities = [data.first_municipality, data.second_municipality, data.third_municipality]
      .map(m => m === "not_sure" ? "" : m)
      .filter(m => m !== undefined && m !== null);
    location_details.location_prl.district_municipality = municipalities;
  }

  return {
    sector,
    size,
    investor_origin,
    location_details: JSON.stringify(location_details)
  };
}

// --- PII Redaction ---

function removePII(text) {
  if (!text || typeof text !== 'string') return text;
  
  let cleanedText = text;

  // 1. Remove email addresses
  cleanedText = cleanedText.replace(
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    '***'
  );

  // 2. Remove phone numbers (various formats)
  // South African format: +27, 0, with/without spaces/dashes
  cleanedText = cleanedText.replace(
    /(\+27|0)\s?(\d{2})\s?\d{3}\s?\d{4}/g,
    '***'
  );
  // General phone pattern (10+ digits with optional formatting)
  cleanedText = cleanedText.replace(
    /(\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{2,4}[-.\s]?\d{3,4}/g,
    (match) => {
      const digitCount = match.replace(/\D/g, '').length;
      return digitCount >= 10 ? '***' : match;
    }
  );

  // 3. Remove GPS coordinates (latitude, longitude)
  cleanedText = cleanedText.replace(
    /-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+/g,
    '***'
  );

  // 4. Remove ID numbers (South African ID format: 13 digits)
  cleanedText = cleanedText.replace(/\b\d{13}\b/g, '***');

  // 5. Use NER to detect and remove person names, places, and organizations
  const doc = nlp(cleanedText);
  
  // Get all people names
  const people = doc.people().out('array');
  people.forEach(name => {
    // Use word boundary regex to replace whole names
    const nameRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    cleanedText = cleanedText.replace(nameRegex, '***');
  });

  // Get all places (cities, countries, regions, addresses)
  const places = doc.places().out('array');
  places.forEach(place => {
    // Exclude "South Africa" and "Africa" as these are contextually important
    if (place.toLowerCase() !== 'south africa' && place.toLowerCase() !== 'africa') {
      const placeRegex = new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      cleanedText = cleanedText.replace(placeRegex, '***');
    }
  });

  // Get organizations (less likely to be PII, but can contain location info)
  const orgs = doc.organizations().out('array');
  orgs.forEach(org => {
    // Only redact if it looks like it might contain location or personal info
    // Skip common acronyms like BEE, BBBEE, etc.
    if (org.length > 5 && !org.match(/^[A-Z]+$/)) {
      const orgRegex = new RegExp(`\\b${org.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      cleanedText = cleanedText.replace(orgRegex, '***');
    }
  });

  // 6. Remove street addresses (number + words + street indicator)
  cleanedText = cleanedText.replace(
    /\b\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s+(?:street|str|road|rd|avenue|ave|drive|dr|lane|ln|crescent|cres|boulevard|blvd|highway|close|square|sq)\b/gi,
    '***'
  );

  return cleanedText;
}

function sanitizeConversation(conversationData) {
  if (!conversationData) return conversationData;
  
  let conversation;
  try {
    conversation = typeof conversationData === 'string' 
      ? JSON.parse(conversationData) 
      : conversationData;
  } catch (err) {
    console.error('Failed to parse conversation data:', err);
    return conversationData;
  }

  if (!Array.isArray(conversation)) {
    return conversationData;
  }

  // Process each message in the conversation
  const sanitized = conversation.map(msg => {
    if (msg.content && typeof msg.content === 'string') {
      return {
        ...msg,
        content: removePII(msg.content)
      };
    }
    return msg;
  });

  return sanitized;
}


// --- Main Cleanup Function ---
async function cleanup() {

    // Check cron IP address
    // (async () => {
    //     const res = await axios.get('https://api.ipify.org?format=json');
    //     console.log(res.data);
    // })();


  try {
    // 1️⃣ Process expired user_terms
    const { rows: expiredTerms } = await query(`
      SELECT * FROM user_terms WHERE expired_at <= NOW()
    `);

    for (const term of expiredTerms) {
      // Find associated conversations
      const { rows: conversations } = await query(`
        SELECT * FROM conversations WHERE phone_number = $1
      `, [term.phone_number]);

      for (const conv of conversations) {

        console.log("Trying to read from user_terms")

        // Parse first_message for structured data
        const { sector, size, investor_origin, location_details } = parseFirstMessage(conv.first_message);

        // Sanitize conversation data (remove PII)
        const sanitizedData = sanitizeConversation(conv.data);
        const sanitizedDataTranslated = sanitizeConversation(conv.data_translated);

        // Prepare long-term data
        const user_id = hashPhoneNumber(conv.phone_number);
        const location = location_details;
        const date = getMonday(conv.started_at);
        const conversation = JSON.stringify(sanitizedData);
        const original_conversation = JSON.stringify(sanitizedDataTranslated);

        // Insert into long-term DB
        await longTermQuery(`
          INSERT INTO survey_responses
          (user_id, location, date, conversation, original_conversation, sector, size, investor_origin)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [user_id, location, date, conversation, original_conversation, sector, size, investor_origin]);

        // Delete messages
        await query(`DELETE FROM messages WHERE conversation_id = $1`, [conv.conversation_id]);

        // Delete conversation
        await query(`DELETE FROM conversations WHERE conversation_id = $1`, [conv.conversation_id]);
      }

      // Delete user_term
      await query(`DELETE FROM user_terms WHERE id = $1`, [term.id]);
    }

    // 2️⃣ Process expired conversations (not already handled)
    const { rows: expiredConvs } = await query(`
      SELECT * FROM conversations WHERE expired_at <= NOW()
    `);

    for (const conv of expiredConvs) {

        console.log("Trying to read from conversations")

      // Parse first_message for structured data
      const { sector, size, investor_origin, location_details } = parseFirstMessage(conv.first_message);

      // Sanitize conversation data (remove PII)
      const sanitizedData = sanitizeConversation(conv.data);
      const sanitizedDataTranslated = sanitizeConversation(conv.data_translated);

      const user_id = hashPhoneNumber(conv.phone_number);
      const location = location_details;
      const date = getMonday(conv.started_at);
      const conversation = JSON.stringify(sanitizedData);
      const original_conversation = JSON.stringify(sanitizedDataTranslated);

      // Insert into long-term DB
      await longTermQuery(`
        INSERT INTO survey_responses
        (user_id, location, date, conversation, original_conversation, sector, size, investor_origin)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `, [user_id, location, date, conversation, original_conversation, sector, size, investor_origin]);

      // Delete messages
      await query(`DELETE FROM messages WHERE conversation_id = $1`, [conv.conversation_id]);

      // Delete conversation
      await query(`DELETE FROM conversations WHERE conversation_id = $1`, [conv.conversation_id]);
    }

    console.log(`✅ Cleanup completed at ${new Date().toISOString()}`);
  } catch (err) {
    console.error('❌ Cleanup error:', err);
  }
}

// Run the cleanup
cleanup();