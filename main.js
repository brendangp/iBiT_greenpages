const express = require("express");
require("dotenv").config();
const { query } = require("./db");
const { sendText, markMessageAsRead } = require("./messages");

const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

/* ---------------- Conversations ---------------- */
async function getOrCreateConversation(phoneNumber) {
  const res = await query(
    `SELECT * FROM conversations 
     WHERE phone_number = $1 
     ORDER BY started_at DESC LIMIT 1`,
    [phoneNumber]
  );

  const existing = res.rows[0];

  if (!existing || existing.state === "finish") {
    const insert = await query(
      `INSERT INTO conversations (phone_number, state) 
       VALUES ($1, 'active') RETURNING *`,
      [phoneNumber]
    );
    return insert.rows[0];
  }
  return existing;
}

/* ---------------- Messages ---------------- */
async function logInboundMessage(conversationId, message, botNumber = null) {
  const wamid = message.id;
  const fromNumber = message.from;
  const toNumber = botNumber || process.env.BOT_PHONE_NUMBER || "unknown";
  const type = message.type;

  let body = null;

  if (type === "text") {
    body = message.text?.body;
  } else if (type === "image") {
    body = "[Image]";
  } else if (type === "document") {
    body = message.document?.filename;
  } else if (type === "button") {
    body = message.button?.text || message.button?.payload;
  } else if (type === "interactive") {
    if (message.interactive?.list_reply) body = message.interactive.list_reply?.title;
    else if (message.interactive?.button_reply) body = message.interactive.button_reply?.title;
  }

  await query(
    `INSERT INTO messages
       (conversation_id, wamid, direction, from_number, to_number, type, body, created_time)
     VALUES ($1, $2, 'inbound', $3, $4, $5, $6, NOW())`,
    [conversationId, wamid, fromNumber, toNumber, type, body]
  );

  return { wamid, body };
}

async function updateMessageStatus(wamid, status) {
  await query(
    `UPDATE messages 
     SET status = $1, updated_time = NOW() 
     WHERE wamid = $2`,
    [status, wamid]
  );
}

/* ---------------- Webhook verification ---------------- */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ---------------- Webhook receiver ---------------- */
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // --- Handle status updates ---
    const incomingStatus = value?.statuses?.[0];
    if (incomingStatus) {
      await updateMessageStatus(incomingStatus.id, incomingStatus.status);
      console.log(`📊 Status update for ${incomingStatus.id}: ${incomingStatus.status}`);
      return;
    }

    // --- Handle inbound messages ---
    const incoming = value?.messages?.[0];
    if (!incoming) return;

    const from = incoming.from;
    console.log("📩 Incoming message from:", from);

    // --- Ensure conversation exists ---
    const conversation = await getOrCreateConversation(from);

    // --- Log inbound message ---
    const botNumber = value?.metadata?.phone_number_id;
    console.log("Bot number:", botNumber);
    console.log(value?.metadata);
    const { wamid, body } = await logInboundMessage(conversation.conversation_id, incoming, botNumber);

    // --- Mark inbound as read ---
    await markMessageAsRead(wamid);

    // --- Echo back the same text ---
    if (body) {
      const replyWamid = await sendText(conversation.conversation_id, from, body, botNumber);  // returns wamid
    }
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
  }
});

/* ---------------- Health check ---------------- */
app.get("/", (_req, res) => res.send("OK"));

/* ---------------- Start server ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot listening on port ${PORT}`));
