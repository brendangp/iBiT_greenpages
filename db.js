// db.js
const { Pool } = require('pg');
require('dotenv').config();

// ----- Short-term DB (existing) -----
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // short-term DB
  ssl: { rejectUnauthorized: false }          // required for Render Postgres
});

// ----- Long-term DB (new) -----
const longTermPool = new Pool({
  connectionString: process.env.LONG_TERM_DB_URL, // long-term DB
  ssl: { rejectUnauthorized: false }
});

// ----- Existing query function (short-term) -----
async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

// ----- New query function for long-term -----
async function longTermQuery(text, params) {
  const res = await longTermPool.query(text, params);
  return res;
}

module.exports = {
  query,           // short-term (existing)
  longTermQuery    // long-term (new)
};
