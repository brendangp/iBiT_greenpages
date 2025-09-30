// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // Render provides this
  ssl: { rejectUnauthorized: false }         // required for Render Postgres
});

async function query(text, params) {
  const res = await pool.query(text, params);
  return res;
}

module.exports = { query };
