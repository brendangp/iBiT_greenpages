const { query, longTermQuery } = require('./db');
const crypto = require('crypto');
const axios = require('axios');

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

// --- Main Cleanup Function ---
async function cleanup() {

    // Check cron IP address
    (async () => {
        const res = await axios.get('https://api.ipify.org?format=json');
        console.log(res.data);
    })();


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

        // Prepare long-term data
        const user_id = hashPhoneNumber(conv.phone_number);
        const location = conv.first_message; // transformations can be added here later
        const date = getMonday(conv.started_at);
        const conversation = conv.data;
        const original_conversation = conv.data_translated;

        // Insert into long-term DB
        await longTermQuery(`
          INSERT INTO survey_responses
          (user_id, location, date, conversation, original_conversation)
          VALUES ($1, $2, $3, $4, $5)
        `, [user_id, location, date, conversation, original_conversation]);

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

      // Prepare long-term data
      const user_id = hashPhoneNumber(conv.phone_number);
      const location = conv.first_message;
      const date = getMonday(conv.started_at);
      const conversation = conv.data;
      const original_conversation = conv.data_translated;

      // Insert into long-term DB
      await longTermQuery(`
        INSERT INTO survey_responses
        (user_id, location, date, conversation, original_conversation)
        VALUES ($1, $2, $3, $4, $5)
      `, [user_id, location, date, conversation, original_conversation]);

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
