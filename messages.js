const axios = require("axios");
const { query } = require("./db");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const api = axios.create({
  baseURL: "https://graph.facebook.com/v21.0",
  headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
});

/**
 * Log outbound message into messages table
 */
async function logOutboundMessage(conversationId, wamid, to, type, body = null) {
  await query(
    `INSERT INTO messages 
       (conversation_id, wamid, direction, from_number, to_number, type, body, status, sent_time) 
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, 'sent', NOW())`,
    [conversationId, wamid, PHONE_NUMBER_ID, to, type, body]
  );
}

/* ---------------- WhatsApp Send Functions ---------------- */

async function sendMenu(conversationId, to, greetingText = null, menuRows = []) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text:
            (greetingText || "Hello 👋 welcome!") +
            "\n\nTo get started, please select an option below.",
        },
        action: {
          button: "View Menu",
          sections: [{ title: "Menu", rows: menuRows }],
        },
      },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) await logOutboundMessage(conversationId, wamid, to, "menu", greetingText);
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send menu:", err.response?.data || err.message);
  }
}

async function sendPDF(conversationId, to, pdfUrl, fileName, caption = null) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: { link: pdfUrl, filename: fileName, caption },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) await logOutboundMessage(conversationId, wamid, to, "pdf", caption || fileName);
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send PDF:", err.response?.data || err.message);
  }
}

async function sendURLButton(conversationId, to, bodyText, buttonText, url) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: bodyText },
        action: {
          name: "cta_url",
          parameters: { display_text: buttonText, url },
        },
      },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) await logOutboundMessage(conversationId, wamid, to, "url_button", `${buttonText} -> ${url}`);
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send URL button:", err.response?.data || err.message);
  }
}

async function sendText(conversationId, to, text) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) await logOutboundMessage(conversationId, wamid, to, "text", text);
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send text:", err.response?.data || err.message);
  }
}

async function markMessageAsRead(messageId) {
  try {
    await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch (err) {
    console.error("❌ Failed to mark as read:", err.response?.data || err.message);
  }
}

module.exports = {
  sendMenu,
  sendPDF,
  sendURLButton,
  sendText,
  markMessageAsRead,
};
