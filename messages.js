const axios = require("axios");
const { query } = require("./db");

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

const api = axios.create({
  baseURL: "https://graph.facebook.com/v21.0",
  headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
});

/*** Log outbound message into messages table*/
async function logOutboundMessage(conversationId, wamid, toNumber, type, body = null, botNumber = null) {
  const fromNumber = botNumber || process.env.BOT_PHONE_NUMBER || "unknown";

  await query(
    `INSERT INTO messages
       (conversation_id, wamid, direction, from_number, to_number, type, body, created_time)
     VALUES ($1, $2, 'outbound', $3, $4, $5, $6, NOW())`,
    [conversationId, wamid, fromNumber, toNumber, type, body]
  );
}


/* ---------------- WhatsApp Send Functions ---------------- */
/// TODO need editing
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

/// TODO need editing
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

/// TODO need editing
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

async function sendText(conversationId, to, text, botNumber) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: text },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) {
      await logOutboundMessage(conversationId, wamid, to, "text", text, botNumber);
    }
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send text:", err.response?.data || err.message);
  }
}

/// Send quick reply buttons (e.g. Continue/Quit)
async function sendButtons(conversationId, to, bodyText, buttons, botNumber) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: { buttons },
      },
    });

    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) {
      // Log outbound message
      const btnLabels = buttons.map(b => b.reply?.title).join(", ");
      await logOutboundMessage(conversationId, wamid, to, "buttons", `${bodyText} [${btnLabels}]`, botNumber);
    }
    return wamid;
  } catch (err) {
    console.error("❌ Failed to send buttons:", err.response?.data || err.message);
  }
}


async function markMessageAsRead(messageId) {
  try {
    // --- Mark as read in WhatsApp API
    await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });

    // --- Update status in your database
    await query(
      `UPDATE messages
       SET status = 'received',
           updated_time = NOW()
       WHERE wamid = $1`,
      [messageId]
    );

    console.log(`✅ Message ${messageId} marked as read and updated in DB`);
  } catch (err) {
    console.error("❌ Failed to mark as read:", err.response?.data || err.message);
  }
}


module.exports = {
  sendMenu,
  sendPDF,
  sendURLButton,
  sendText,
  sendButtons,
  markMessageAsRead,
};
