const express = require("express");
require("dotenv").config();
const { query } = require("./db");
const { sendText, sendButtons, sendFlow, sendLocationRequest, markMessageAsRead } = require("./messages");
const prompts = require("./prompts");
const { getResponses } = require("./openai_functions");
// near other requires
const { detectAndTranslate, translateToSelectedLanguage } = require("./translate");


const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
      // console.log(`📊 Status update for ${incomingStatus.id}: ${incomingStatus.status}`);
      return;
    }

    // --- Handle inbound messages ---
    const incoming = value?.messages?.[0];
    if (!incoming) return;

    const from = incoming.from;
    console.log("📩 Incoming message from:", from);

    // Check for voice note
    if (incoming.type === "audio") {
      console.log(`🎵 Voice note received from ${from}:`);
      console.log("  id:", incoming.audio?.id);
      console.log("  mime_type:", incoming.audio?.mime_type);
      console.log("  sha256:", incoming.audio?.sha256);
      return;
    }

    // --- Ensure conversation exists ---
    const conversation = await getOrCreateConversation(from);

    // --- Log inbound message ---
    const botNumber = value?.metadata?.display_phone_number;

    // Handle translation
    let detectedLanguage = null;
    let translatedText = null;
    let originalText = incoming.text?.body || null;

    if (incoming.type === "text" && originalText) {
      // detect & translate
      const tr = await detectAndTranslate(originalText, 'en'); // default target en
      detectedLanguage = tr.originalLanguage || null;
      translatedText = tr.translatedText || originalText;
    } else {
      // non-text messages keep null
      translatedText = originalText;
    }

    const { wamid, body } = await logInboundMessage(conversation.conversation_id, incoming, botNumber);
    await markMessageAsRead(wamid);

    // --- If Quit is typed at any stage, perform the following ---
    if ( incoming.type === "text" && body && body.trim().toLowerCase() === "quit") {
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

    // --- If "form" is typed at any stage, send a Flow ---
    // if (incoming.type === "text" && body && body.trim().toLowerCase() === "form") {
    //   await sendFlow(
    //     conversation.conversation_id,
    //     from,
    //     prompts.flow_params.flowId,        // 👈 put your real flow_id in .env
    //     prompts.flow_params.flowCta,                // button text
    //     "This is a test round first about",                    // could pull from your DB or user profile
    //     botNumber
    //   );
    //   return;
    // }

    // Decide which message content to use
    let messageForAI;

    if (detectedLanguage === "en" || detectedLanguage === "eng" || detectedLanguage?.startsWith("en")) {
      messageForAI = body;
    } else {
      messageForAI = translatedText || body; // fallback to body if translation failed
    }

    console.log(`🗣️ Using message for AI: "${messageForAI}" (lang=${detectedLanguage})`);

    // --- State machine logic ---
    switch (conversation.state) {
      case "active":
        // Handle interactive buttons first
        if (incoming.type === "interactive" && incoming.interactive?.button_reply) {
          const replyId = incoming.interactive.button_reply.id;

          if (replyId === "continue_terms") {
            await query(
              `UPDATE conversations 
               SET terms_accepted = true, state = 'unstructured', updated_time = NOW() 
               WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );

            const resPending = await query(
              `SELECT data, data_translated, language FROM conversations WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );

            let pendingData = resPending.rows[0]?.data || [];
            let pendingDataTranslated = resPending.rows[0]?.data_translated || [];
            const convLanguage = resPending.rows[0]?.language || 'en';

            let saveData = [...pendingData]; // copy for saving, does not include system prompt
            let saveDataTranslated = [...pendingDataTranslated];

            // Prepare AI input with system prompt (but do not save this in DB)
            const aiInput = [...pendingData, { role: "system", content: prompts.system_prompt }];

            const aiResponse = await getResponses(aiInput);

            if (aiResponse) {
              let messageText = aiResponse.text;

              // Translate if conversation.language is not English
              if (convLanguage && convLanguage !== 'en') {
                const translated = await translateToSelectedLanguage(messageText, convLanguage);
                messageText = translated;
              }

              console.log("🤖 AI Response:", messageText);
              await sendText(conversation.conversation_id, from, messageText, botNumber);

              // Append AI response to data array
              saveData.push({ role: "assistant", content: aiResponse.text });
              saveDataTranslated.push({ role: "assistant", content: messageText });

              // Update conversation in database
              await query(
                `UPDATE conversations 
                SET data = $1, data_translated = $2, updated_time = NOW() 
                WHERE conversation_id = $3`,
                [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), conversation.conversation_id]
              );
            }

            return;
          }

          if (replyId === "quit_terms") {
            await query(
              `UPDATE conversations SET first_message = NULL, state = 'finish', updated_time = NOW() WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );
            await sendText(conversation.conversation_id, from, prompts.quit_response, botNumber);
            return;
          }
        }

        // Terms not accepted yet: store pending message and send terms
        if (!conversation.terms_accepted) {
          const messageEnglish = messageForAI;
          const messageOriginal = body || "[Non-text message]";

          const dataArray = [{ role: "user", content: messageEnglish }];
          const dataTranslatedArray = [{ role: "user", content: messageOriginal }];

          await query(
            `UPDATE conversations 
            SET data = $1, 
                data_translated = $2, 
                language = $3,
                updated_time = NOW() 
            WHERE conversation_id = $4`,
            [
              JSON.stringify(dataArray),
              JSON.stringify(dataTranslatedArray),
              detectedLanguage, // the detected language code, e.g., "en" or "fr"
              conversation.conversation_id
            ]
          );

          await sendButtons(
            conversation.conversation_id,
            from,
            prompts.terms_of_use_message,
            [
              { type: "reply", reply: { id: "continue_terms", title: "Continue" } },
              { type: "reply", reply: { id: "quit_terms", title: "Quit" } }
            ],
            botNumber,
            prompts.terms_of_use_footer
          );
        }
        break;

      case "unstructured":

        // console.log(`🟢 [unstructured] conversation ${conversation.conversation_id}`);

        // const messageContent = incoming.text?.body || "[Non-text message]";

        const resPending = await query(
          `SELECT data, data_translated, language FROM conversations WHERE conversation_id = $1`,
          [conversation.conversation_id]
        );

        let pendingData = resPending.rows[0]?.data || [];
        let pendingDataTranslated = resPending.rows[0]?.data_translated || [];
        const convLanguage = resPending.rows[0]?.language || 'en';

        let saveData = [...pendingData]; // copy of conversation history
        let saveDataTranslated = [...pendingDataTranslated];

        // Add the new user message to both saveData and AI input
        saveData.push({ role: "user", content: translatedText });
        saveDataTranslated.push({ role: "user", content: originalText });

        // Count user messages
        const userMessageCount = pendingData.filter(msg => msg.role === "user").length;
        console.log(`📝 User message count: ${userMessageCount}`);

        if (userMessageCount + 1 >= prompts.message_limt) {
          
          await sendFlow(
            conversation.conversation_id,
            from,
            prompts.flow_params.flowId,
            prompts.flow_params.flowCta,
            "You've reached the message limit, please complete this form.",
            botNumber,
            "Powered by greenpages.app"
          );

          // Save conversation state + message limit
          await query(
            `UPDATE conversations 
            SET data = $1, data_translated = $2, updated_time = NOW(), state = 'structured', message_limit = $3 
            WHERE conversation_id = $4`,
            [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), userMessageCount + 1, conversation.conversation_id]
          );

          break; // ⛔ stop further AI processing
        }

        // Prepare AI input: all history + system prompt
        const aiInput = [
          ...pendingData,
          { role: "user", content: `± ${translatedText} ±` },  // wrapped only for AI
          { role: "system", content: prompts.system_prompt }
        ];

        const aiResponse = await getResponses(aiInput);

        if (aiResponse) {
          const responseType = aiResponse.type || "-";
          let messageText = aiResponse.text || aiResponse; // fallback

          if (responseType === "-") {

            // Translate if conversation language is not English
            if (convLanguage && convLanguage !== 'en') {
              const translated = await translateToSelectedLanguage(messageText, convLanguage);
              messageText = translated;
            }

            // 🔹 Standard text response
            console.log("🤖 AI Response:", messageText);
            await sendText(conversation.conversation_id, from, messageText, botNumber);

            // Save to history
            saveData.push({ role: "assistant", content: aiResponse.text });
            saveDataTranslated.push({ role: "assistant", content: messageText });

            await query(
              `UPDATE conversations 
              SET data = $1, data_translated = $2, updated_time = NOW(), message_limit = $3 
              WHERE conversation_id = $4`,
              [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), userMessageCount + 1, conversation.conversation_id]
            );

          } else if (responseType === "location_request") {
            
            console.log("📍 AI requested location flow");
            await sendFlow(
              conversation.conversation_id,
              from,
              prompts.flow_params.flowId,
              prompts.flow_params.flowCta,
              messageText, 
              botNumber,
              "Powered by greenpages.app"
            );

            // Save special marker in history
            saveData.push({ role: "assistant", content: "[Location Flow Sent]" });
            saveDataTranslated.push({ role: "assistant", content: "[Location Flow Sent]" });

            await query(
              `UPDATE conversations 
              SET data = $1, data_translated = $2, updated_time = NOW(), state = 'structured', message_limit = $3 
              WHERE conversation_id = $4`,
              [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), userMessageCount + 1, conversation.conversation_id]
            );
          } else {
            console.warn("⚠️ Unknown AI response type:", responseType);
          }
        }

        break;

      case "structured":
        // console.log(`🟡 [structured] conversation ${conversation.conversation_id}`);

        if (incoming.type === "interactive" && incoming.interactive?.type === "nfm_reply") {
          const nfm = incoming.interactive.nfm_reply;

          try {
            const responseData = JSON.parse(nfm.response_json);

            // Remove flow_token from response
            const { flow_token, ...savedData } = responseData;

            // Save the response in first_message
            await query(
              `UPDATE conversations 
              SET first_message = $1, updated_time = NOW()
              WHERE conversation_id = $2`,
              [JSON.stringify(savedData), conversation.conversation_id]
            );

            // console.log("📋 Received form response:", savedData);

            // Thank the user
            const botNumber = value?.metadata?.display_phone_number;

            // If region is municipal, ask for location and keep state structured
            if (savedData.region?.toLowerCase() === "municipal") {
              await sendLocationRequest(
                conversation.conversation_id,
                from,
                "Please provide us with the location where this is taking place.", // your custom message text
                botNumber
              );

              // console.log("📍 Waiting for location from user...");

            } else {
              // Otherwise, thank the user and finish conversation
              await sendText(
                conversation.conversation_id,
                from,
                prompts.response_to_location_pin,
                botNumber
              );

              await query(
                `UPDATE conversations 
                SET state = 'finish', updated_time = NOW() 
                WHERE conversation_id = $1`,
                [conversation.conversation_id]
              );
            }
          } catch (err) {
            console.error("❌ Failed to parse form response JSON:", nfm.response_json, err.message);
          }

        } else if (incoming.type === "location") {
          // Log user location
          // console.log("📍 User sent location:", incoming.location);
          const botNumber = value?.metadata?.display_phone_number;

          // Fetch existing first_message
          const res = await query(
            `SELECT first_message FROM conversations WHERE conversation_id = $1`,
            [conversation.conversation_id]
          );

          let firstMessageData = {};
          try {
            firstMessageData = res.rows[0]?.first_message
              ? JSON.parse(res.rows[0].first_message)
              : {};
          } catch (err) {
            console.error("❌ Failed to parse existing first_message JSON:", err.message);
          }

          // Store the entire location object
          firstMessageData.location = incoming.location;

          // Mark conversation finished
          await query(
            `UPDATE conversations 
            SET state = 'finish', updated_time = NOW(), first_message = $1 
            WHERE conversation_id = $2`,
            [JSON.stringify(firstMessageData), conversation.conversation_id]
          );

          await sendText(
            conversation.conversation_id,
            from,
            prompts.response_to_location_pin, // your thank-you text
            botNumber
          );

          // Log updated first_message
          // console.log("📋 Updated first_message with location:", firstMessageData);

        } else {
          // Not a form response → mark conversation finished
          console.log("⚠️ Received non-form response in structured state. Finishing conversation.");
          await query(
            `UPDATE conversations 
            SET state = 'finish', updated_time = NOW() 
            WHERE conversation_id = $1`,
            [conversation.conversation_id]
          );
        }
        break;
        

      case "finish":
        // Nothing happens
        console.log(`⚪ Conversation ${conversation.conversation_id} is finished`);
        break;

      default:
        console.warn(`Unknown state ${conversation.state} for conversation ${conversation.conversation_id}`);
        break;
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
