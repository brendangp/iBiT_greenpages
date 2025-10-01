const express = require("express");
require("dotenv").config();
const { query } = require("./db");
const { sendText, sendButtons, markMessageAsRead } = require("./messages");
const prompts = require("./prompts");

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
  try {
    // Fetch current status
    const res = await query(
      `SELECT status FROM messages WHERE wamid = $1`,
      [wamid]
    );

    const currentStatus = res.rows[0]?.status;

    // Only update if current status is not 'read'
    if (currentStatus && currentStatus !== 'read') {
      await query(
        `UPDATE messages 
         SET status = $1, updated_time = NOW() 
         WHERE wamid = $2`,
        [status, wamid]
      );
      console.log(`📊 Message ${wamid} status updated to ${status}`);
    }
  } catch (err) {
    console.error(`❌ Failed to update status for ${wamid}:`, err.message);
  }
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
    const botNumber = value?.metadata?.display_phone_number;

    const { wamid, body } = await logInboundMessage(conversation.conversation_id, incoming, botNumber);

    // --- Mark inbound as read ---
    await markMessageAsRead(wamid);

    // --- Handle terms reply buttons ---
    if (incoming.type === "interactive" && incoming.interactive?.button_reply) {
      const replyId = incoming.interactive.button_reply.id;

      if (replyId === "continue_terms") {
        await query(
          `UPDATE conversations 
           SET terms_accepted = true, state = 'unstructured', updated_time = NOW() 
           WHERE conversation_id = $1`,
          [conversation.conversation_id]
        );

        // Send back the pending data
        const resPending = await query(
          `SELECT first_message FROM conversations WHERE conversation_id = $1`,
          [conversation.conversation_id]
        );
        const pendingData = resPending.rows[0]?.data;

        if (pendingData) {
          await sendText(conversation.conversation_id, from, pendingData, botNumber);
          await query(
            `UPDATE conversations SET first_message = NULL, updated_time = NOW() WHERE conversation_id = $1`,
            [conversation.conversation_id]
          );
        }
        return;
      }

      if (replyId === "quit_terms") {
        await query(
          `UPDATE conversations SET first_message = NULL, state = 'finish', updated_time = NOW() WHERE conversation_id = $1`,
          [conversation.conversation_id]
        );
        await sendText(
          conversation.conversation_id,
          from,
          prompts.quit_response,
          botNumber
        );
        return;
      }
    }

    // If terms not accepted yet
    if (!conversation.terms_accepted) {
      const body = incoming.text?.body || "[Non-text message]";

      // Store the pending message
      await query(
        `UPDATE conversations 
         SET first_message = $1, updated_time = NOW() 
         WHERE conversation_id = $2`,
        [body, conversation.conversation_id]
      );

      // Send Terms & Conditions with Continue/Quit buttons
      await sendButtons(
        conversation.conversation_id,
        from,
        prompts.terms_of_use_message,
        [
          { type: "reply", reply: { id: "continue_terms", title: "Continue" } },
          { type: "reply", reply: { id: "quit_terms", title: "Quit" } }
        ],
        botNumber
      );

      return; // stop here until terms accepted
    }

    // --- Echo back the same text ---
    // if (body) {
    //   const replyWamid = await sendText(conversation.conversation_id, from, body, botNumber);  // returns wamid
    // }
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
  }
});

/* ---------------- Health check ---------------- */
app.get("/", (_req, res) => res.send("OK"));

/* ---------------- Start server ---------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot listening on port ${PORT}`));
