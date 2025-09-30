const express = require("express");
require("dotenv").config();
const { query } = require("./db");
const {
  sendMenu,
  sendPDF,
  sendURLButton,
  sendText,
  markMessageAsRead
} = require("./messages");

const app = express();
app.use(express.json());

// --- Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// --- Contacts DB
async function upsertContact(number, name) {
  const existing = await query(`SELECT id FROM contacts WHERE number = $1`, [number]);
  if (!existing.rows.length) {
    await query(
      `INSERT INTO contacts (number, name, date_added) VALUES ($1, $2, NOW())`,
      [number, name]
    );
  }
}

async function getContact(number) {
  const res = await query(`SELECT * FROM contacts WHERE number = $1`, [number]);
  return res.rows[0];
}

async function updateOptIn(number, optedIn) {
  await query(`UPDATE contacts SET opted_in = $1 WHERE number = $2`, [
    optedIn,
    number,
  ]);
}

async function logOutboundMessage(recipient, type, wamid, body = null) {
  await query(
    `INSERT INTO bot_messages (wamid, direction, recipient, type, body, status, sent_time)
     VALUES ($1, 'outbound', $2, $3, $4, 'sent', NOW())`,
    [wamid, recipient, type, body]
  );
}

async function logInboundMessage(message) {
  const wamid = message.id;
  const from = message.from;
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
  const res = await query(`SELECT status FROM bot_messages WHERE wamid = $1`, [
    wamid,
  ]);
  const currentStatus = res.rows[0]?.status;

  if (currentStatus !== "read") {
    await query(
      `UPDATE bot_messages 
       SET status = $1, updated_time = NOW() 
       WHERE wamid = $2`,
      [status, wamid]
    );
  }
}

// --- Menu definition (still here so main controls it)
const menuRows = [
  { id: "programme", title: "📋 Programme", description: "View the programme for the day." },
  { id: "speakers", title: "🎤 Speakers", description: "View all the speakers." },
  { id: "faq", title: "❔ FAQs", description: "View the most frequently asked questions." },
  { id: "venue", title: "🏢 Venue Info", description: "Find out where the summit is taking place." },
  { id: "tickets", title: "🎟️ Tickets", description: "Book your ticket now!" },
  { id: "opt_out", title: "❌ Opt Out", description: "Opt Out from receiving marketing messages" },
];

// --- For Campaign messages (using template)
app.post("/sendMessage", async (req, res) => {
  const { to, templateName, language, components } = req.body;
  try {
    const wamid = await sendText.sendTemplate(to, templateName, language, components);
    await logOutboundMessage(to, "campaign", wamid, templateName);
    res.json({ success: true, wamid });
  } catch (err) {
    console.error("❌ SendMessage error:", err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

// --- Webhook verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// --- Webhook receiver
app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;

    const incomingStatus = value?.statuses?.[0];
    if (incomingStatus) {
      await updateMessageStatus(incomingStatus.id, incomingStatus.status);
      console.log(`📊 Status update for ${incomingStatus.id}: ${incomingStatus.status}`);
    }

    const incoming = value?.messages?.[0];
    if (!incoming) return;

    const from = incoming.from;
    const name = value?.contacts?.[0]?.profile?.name || "Guest";
    console.log("📩 Incoming message from:", from);

    await logInboundMessage(incoming);
    await markMessageAsRead(incoming.id);

    let contact = await getContact(from);
    if (!contact) {
      await upsertContact(from, name);
      contact = { name };
    }

    const greeting = `Hello ${contact.name} 👋 welcome to *Smarter Mobility Africa*!`;

    if (incoming.type === "text") {
      const body = incoming.text?.body?.trim().toLowerCase();
      if (body === "out") {
        await updateOptIn(from, false);
        await sendText(from, "❌ You have successfully opted out.");
        return;
      }
    }

    if (incoming.type === "interactive" && incoming.interactive?.list_reply) {
      const selectedId = incoming.interactive.list_reply.id;
      const selectedRow = menuRows.find((r) => r.id === selectedId);

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
              bodyText = "🏢 Here’s where the Summit is taking place.\n\n_*Sandton Convention Centre*_";
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
          await sendText(from, selectedRow.description);
        }
      }
    } else {
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
