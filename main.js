const express = require("express");
const axios = require("axios");
require("dotenv").config();
const { query } = require('./db');

const app = express();
app.use(express.json());

// --- Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// --- Axios client
const api = axios.create({
  baseURL: "https://graph.facebook.com/v21.0",
  headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
});

// --- Contacts DB
async function upsertContact(number, name) {
  const existing = await query(`SELECT id FROM contacts WHERE number = $1`, [number]);
  if (!existing.rows.length) {
    await query(`INSERT INTO contacts (number, name, date_added) VALUES ($1, $2, NOW())`, [number, name]);
  }
}

async function getContact(number) {
  const res = await query(`SELECT * FROM contacts WHERE number = $1`, [number]);
  return res.rows[0];
}

async function updateOptIn(number, optedIn) {
  await query(
    `UPDATE contacts SET opted_in = $1 WHERE number = $2`,
    [optedIn, number]
  );
}

module.exports = { upsertContact, getContact, updateOptIn };

async function logOutboundMessage(recipient, type, wamid, body = null) {
  await query(
    `INSERT INTO bot_messages (wamid, direction, recipient, type, body, status, sent_time)
     VALUES ($1, 'outbound', $2, $3, $4, 'sent', NOW())`,
    [wamid, recipient, type, body]
  );
}

async function logInboundMessage(message) {
  const wamid = message.id;
  const from = message.from;   // user phone number
  const type = message.type;
  let body = null;

  if (type === "text") {
    body = message.text?.body;
  } else if (type === "interactive") {
    if (message.interactive?.type?.toLowerCase() === "list_reply") {
      body = message.interactive.list_reply?.title;
    } else if (message.interactive?.type?.toLowerCase() === "button_reply") {
      body = message.interactive.button_reply?.title;
    }
  } else if (type === "button") {
    // 👇 template button press (quick reply, cta_url, etc.)
    body = message.button?.text || message.button?.payload;
  } else if (type === "image") {
    body = "[Image]";
  } else if (type === "document") {
    body = message.document?.filename;
  }

  await query(
    `INSERT INTO bot_messages (wamid, direction, recipient, type, body, status, sent_time)
     VALUES ($1, 'inbound', $2, $3, $4, 'received', NOW())`,
    [wamid, from, type, body]
  );
}


async function updateMessageStatus(wamid, status) {
  // Fetch current status
  const res = await query(
    `SELECT status FROM bot_messages WHERE wamid = $1`,
    [wamid]
  );

  const currentStatus = res.rows[0]?.status;

  // Only update if current status is not 'read'
  if (currentStatus !== 'read') {
    await query(
      `UPDATE bot_messages 
       SET status = $1, updated_time = NOW() 
       WHERE wamid = $2`,
      [status, wamid]
    );
  }
}

async function markMessageAsRead(messageId) {
  try {
    await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
    console.log(`✅ Marked message ${messageId} as read`);
  } catch (err) {
    console.error("❌ Failed to mark as read:", err.response?.data || err.message);
  }
}




// --- Menu definition
const menuRows = [
  {
    id: "programme",
    title: "📋 Programme",
    description: "View the programme for the day.",
  },
  {
    id: "speakers",
    title: "🎤 Speakers",
    description: "View all the speakers.",
  },
  {
    id: "faq",
    title: "❔ FAQs",
    description: "View the most frequently asked questions.",
  },
  {
    id: "venue",
    title: "🏢 Venue Info",
    description: "Find out where the summit is taking place.",
  },
  {
    id: "tickets",
    title: "🎟️ Tickets",
    description: "Book your ticket now!",
  },
  {
    id: "opt_out",
    title: "❌ Opt Out",
    description: "Opt Out from receiving marketing messages",
  }
];

// --- Send interactive menu
async function sendMenu(to, greetingText = null) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: {
          text: (greetingText || "Hello 👋 welcome to *Smarter Mobility Africa*") + "\n\n" +
                "To get started, please select any one of the following options:\n" +
                "📋 You can view the listings below.\n\n" +
                "We look forward to seeing you at the Summit! 🎉🤝"
        },
        action: {
          button: "View Menu",
          sections: [
            {
              title: "Menu",
              rows: menuRows,
            }
          ],
        },
      },
    });

    // --- Log the outbound message
    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) {
      const menuBody = greetingText || "Menu sent"; // optional: save greeting
      await logOutboundMessage(to, 'menu', wamid, menuBody); // type is 'menu'
    }

    console.log("✅ Menu sent to", to);
  } catch (err) {
    console.error("❌ Failed to send menu:", err.response?.data || err.message);
  }
}



// --- Send PDF document with optional caption
async function sendPDF(to, pdfUrl, fileName, caption = null) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "document",
      document: {
        link: pdfUrl,
        filename: fileName,
        caption: caption,   // caption text appears with the PDF
      },
    });

    // --- Log the outbound message
    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) {
      const pdfBody = caption || fileName;
      await logOutboundMessage(to, fileName, wamid, pdfBody);
    }
    
    console.log(`✅ Sent PDF to ${to}: ${fileName}`);
  } catch (err) {
    console.error("❌ Failed to send PDF:", err.response?.data || err.message);
  }
}

// --- Send URL button message
async function sendURLButton(to, bodyText, buttonText, url) {
  try {
    const res = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { 
          text: bodyText 
        },
        action: {
          name: "cta_url",
          parameters: {
            display_text: buttonText,
            url: url
          }
        }
      }
    });

    // --- Log the outbound message
    const wamid = res.data?.messages?.[0]?.id;
    if (wamid) {
      const buttonBody = `${buttonText} -> ${url}`;
      await logOutboundMessage(to, buttonText, wamid, buttonBody);
    }
    
    console.log(`✅ Sent URL button to ${to}: ${buttonText} -> ${url}`);
  } catch (err) {
    console.error("❌ Failed to send URL button:", err.response?.data || err.message);
  }
}


// --- Send simple text message
async function sendText(to, text) {
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
      await logOutboundMessage(to, 'text', wamid, text);
    }
    
    console.log(`✅ Sent text to ${to}:`, text);
  } catch (err) {
    console.error("❌ Failed to send text:", err.response?.data || err.message);
  }
}

// --- For Campaign messages (using template)
app.post("/sendMessage", async (req, res) => {
  const { to, templateName, language, components } = req.body;

  try {
    const response = await api.post(`/${PHONE_NUMBER_ID}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,             // 👈 Meta-approved template name
        language: { code: language },   // e.g. "en_US"
        components: components || []    // optional: variables, buttons
      },
    });

    const wamid = response.data?.messages?.[0]?.id;

    // --- Log the outbound message
    await logOutboundMessage(to, "campaign", wamid, templateName);

    res.json({ success: true, wamid });
  } catch (err) {
    console.error("❌ SendMessage error:", err.response?.data || err.message);
    res
      .status(500)
      .json({ success: false, error: err.response?.data || err.message });
  }
});



// --- Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook receiver (POST)
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // respond immediately

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    // --- Handle message status updates
    const incomingStatus = value?.statuses?.[0];
    if (incomingStatus) {
      const wamid = incomingStatus.id;              // Meta message ID
      const status = incomingStatus.status;        // sent, delivered, read
      await updateMessageStatus(wamid, status);
      console.log(`📊 Status update for ${wamid}: ${status}`);
    }

    // --- Handle incoming messages
    const incoming = value?.messages?.[0];
    if (!incoming) return;

    const from = incoming.from;
    const name = value?.contacts?.[0]?.profile?.name || "Guest";
    console.log("📩 Incoming message from:", from);

    // Save inbound message
    await logInboundMessage(incoming);
    
    // Mark as read
    await markMessageAsRead(incoming.id);

    // --- Check/add contact
    let contact = await getContact(from);
    if (!contact) {
      await upsertContact(from, name);   // add new user
      contact = { name };                // use name for greeting
    }

    // --- Prepare greeting
    const greeting = `Hello ${contact.name} 👋 welcome to *Smarter Mobility Africa*!`;

    // --- Handle opt-out via text message
    if (incoming.type === "text") {
      const body = incoming.text?.body?.trim().toLowerCase();
      if (body === "out") {
        await updateOptIn(from, false);
        await sendText(from, "❌ You have successfully opted out.");
        return; // stop further processing
      }
    }


    // Check if user selected an item from the menu
    if (incoming.type === "interactive" && incoming.interactive?.list_reply) {
      const selectedId = incoming.interactive.list_reply.id;
      const selectedRow = menuRows.find(r => r.id === selectedId);

      if (selectedRow) {
        if (selectedId === "opt_out") {
          await updateOptIn(from, false);
          await sendText(from, "❌ You have successfully opted out.");
        } else if (["speakers", "programme", "venue", "tickets", "faq"].includes(selectedId)) {
          
          let bodyText = "";
          let buttonText = "";
          let url = "";
        
          switch (selectedId) {
            case "programme":
              bodyText = "📋 Here is the programme for the day.";
              buttonText = "Programme";
              url = "https://share-eu1.hsforms.com/1RSJXGGK9TEqES1Egu3hJaQewv4c";
              break;
            case "speakers":
              bodyText = "🎤 Check out all the speakers presenting at the summit!";
              buttonText = "View Speakers";
              url = "https://wearevuka.com/mobility/sma-summit/sma-speakers/";
              break;
            case "venue":
              bodyText = "🏢 Here’s where the Summit is taking place.\n\n" +
                        "_*Sandton Convention Centre*_\n\n" +
                        "Find more venue details below.";
              buttonText = "View Venue Info";
              url = "https://wearevuka.com/sma-plan-your-trip/";
              break;
            case "tickets":
              bodyText = "🎟️ Don’t miss out! Book your tickets for the Summit now.";
              buttonText = "Book Tickets";
              url = "https://wearevuka.com/mobility/sma-summit/tickets/";
              break;
            case "faq":
              bodyText = "❔ Here are the Frequently Asked Questions.";
              buttonText = "FAQs";
              url = "https://drive.google.com/uc?export=download&id=1hAt94riLEzAPeCL__muvjfrsldEVeawU";
              break;
          }
        
          await sendURLButton(from, bodyText, buttonText, url);
        } else {
          // Fallback: send description text
          await sendText(from, selectedRow.description);
        }
      }
    } else {
      // Otherwise always reply with interactive menu
      await sendMenu(from, greeting);
    }
  } catch (err) {
    console.error("Webhook error:", err.response?.data || err.message);
  }
});

// --- Health check
app.get("/", (_req, res) => res.send("OK"));

// --- Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Bot listening on port ${PORT}`));
