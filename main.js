const express = require("express");
require("dotenv").config();
const { query } = require("./db");
const { sendText, sendButtons, sendFlow, sendLocationRequest, markMessageAsRead } = require("./messages");
const prompts = require("./prompts");
const { getResponses, handleVoiceNote } = require("./openai_functions");
// near other requires
const { detectAndTranslate, translateToSelectedLanguage } = require("./translate");


const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

/* ---------------- Conversations ---------------- */
async function getOrCreateConversation(phoneNumber) {
  // 1️⃣ Ensure user_terms entry exists
  const userTerms = await query(
    `SELECT id FROM user_terms WHERE phone_number = $1 LIMIT 1`,
    [phoneNumber]
  );

  if (userTerms.rows.length === 0) {
    await query(
      `INSERT INTO user_terms (phone_number, terms_accepted, created_at, expired_at)
      VALUES ($1, false, NOW(), NOW() + INTERVAL '24 hours')`,
      [phoneNumber]
    );
  }

  // 2️⃣ Get or create conversation
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

/* ---------------- User Terms ---------------- */
async function checkUserTerms(phoneNumber) {
  const res = await query(`SELECT * FROM user_terms WHERE phone_number = $1`, [phoneNumber]);
  return res.rows[0] || null;
}

async function saveUserTerms(phoneNumber, accepted) {
  await query(
    `UPDATE user_terms 
     SET terms_accepted = $1, updated_at = NOW() 
     WHERE phone_number = $2`,
    [accepted, phoneNumber]
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
      // console.log(`📊 Status update for ${incomingStatus.id}: ${incomingStatus.status}`);
      return;
    }

    // --- Handle inbound messages ---
    const incoming = value?.messages?.[0];
    if (!incoming) return;

    const from = incoming.from;
    console.log("📩 Incoming message from number:", from);

    // Check for voice note
    if (incoming.type === "audio" && incoming.audio?.id) {
      const transcriptionText = await handleVoiceNote(incoming.audio.id);

      if (transcriptionText) {
        incoming.text = { body: transcriptionText }; // inject into message structure
        incoming.type = "text"; // so your logic sees it as normal text
      } else {
        console.warn("⚠️ Transcription failed — skipping text logic");

        // Send polite message back to user
        await sendText(
          conversation.conversation_id,
          from, 
          "Sorry, I was unable to understand what you were saying just now. Please type it out.",
          botNumber
        );
        return;
      }
    }

    // --- Check if user has accepted Terms ---
    const userTerms = await checkUserTerms(from);
    // --- Ensure conversation exists ---
    const conversation = await getOrCreateConversation(from);

    // --- Log inbound message ---
    const botNumber = value?.metadata?.display_phone_number;

    // Handle translation
    let detectedLanguage = null;
    let translatedText = null;
    let originalText = incoming.text?.body || null;
    let shouldUseEnglish = false;
    let detectionConfidence = 0;

    // Translate text if necessary
    if (incoming.type === "text" && originalText) {
      // detect & translate
      const tr = await detectAndTranslate(originalText, 'en', 0.8); // default target en
      detectedLanguage = tr.originalLanguage || 'en';
      translatedText = tr.translatedText || originalText;
      shouldUseEnglish = tr.shouldUseEnglish || false;
      detectionConfidence = tr.confidence || 0;

      console.log(`🌐 Language Detection: ${detectedLanguage} (confidence: ${detectionConfidence}, useEnglish: ${shouldUseEnglish})`);
    } else {
      // non-text messages keep null
      translatedText = originalText;
      detectedLanguage = 'en';
    }

    // Save incomming message
    const { wamid, body } = await logInboundMessage(conversation.conversation_id, incoming, botNumber);
    await markMessageAsRead(wamid);

    // --- If Quit is typed at any stage, perform the following ---
    if ( incoming.type === "text" && body && body.trim().toLowerCase() === "quit") {
      // Have to send text first to stop errors
      await sendText(
        conversation.conversation_id,
        from,
        prompts.quit_response,
        botNumber
      );

      // Delete data
      await query(
        `DELETE FROM user_terms WHERE phone_number = $1`,
        [from]
      );

      await query(
        `DELETE FROM messages WHERE conversation_id = $1`,
        [conversation.conversation_id]
      );

      await query(
        `DELETE FROM conversations WHERE conversation_id = $1`,
        [conversation.conversation_id]
      );

      return;
    }

    // --- If "form" is typed at any stage, send a Flow ---
    // if (incoming.type === "text" && body && body.trim().toLowerCase() === "form") {
    //   await sendFlow(
    //     conversation.conversation_id,
    //     from,
    //     1211841967129307,        // 👈 put your real flow_id in .env
    //     prompts.flow_params.flowCta,                // button text
    //     "This is a test round first about",                    // could pull from your DB or user profile
    //     botNumber
    //   );
    //   return;
    // }
    // if (incoming.type === "interactive" && incoming.interactive?.type === "nfm_reply") {
    //   const nfm = incoming.interactive.nfm_reply;

    //   // Print the full payload
    //   console.log("📦 Form payload received:", JSON.stringify(nfm, null, 2));

    //   // If needed, parse JSON from the response
    //   try {
    //     const responseData = JSON.parse(nfm.response_json);
    //     console.log("📝 Parsed form data:", responseData);
    //   } catch (err) {
    //     console.error("❌ Failed to parse form response JSON:", nfm.response_json, err.message);
    //   }
    //   return;
    // }

    // Decide which message content to use
    let messageForAI = translatedText || body;

    // if (detectedLanguage === "en" || detectedLanguage === "eng" || detectedLanguage?.startsWith("en")) {
    //   messageForAI = body;
    // } else {
    //   messageForAI = translatedText || body; // fallback to body if translation failed
    // }

    console.log(`🗣️ Using message for AI: "${messageForAI}" (lang=${detectedLanguage})`);

    let isReturningUserFirstMessage = false;

    // --- Determine how to proceed for active/unstructured based on user_terms---
    if (conversation.state === "active" && userTerms && userTerms.terms_accepted) {
      console.log("✅ Returning user — skipping terms");

      // Immediately set conversation state to unstructured if not already
      if (conversation.state !== "unstructured") {
        // ✅ FIX: Initialize data arrays for returning users
        isReturningUserFirstMessage = true;

        const dataArray = [{ role: "user", content: messageForAI }];
        const dataTranslatedArray = [{ role: "user", content: body }];

        await query(
          `UPDATE conversations 
          SET state = 'unstructured', 
              terms_accepted = true, 
              data = $1, 
              data_translated = $2, 
              language = $3, 
              updated_time = NOW() 
          WHERE conversation_id = $4`,
          [
            JSON.stringify(dataArray), 
            JSON.stringify(dataTranslatedArray), 
            detectedLanguage || 'en',
            conversation.conversation_id
          ]
        );
      }

      // Skip the “active” case entirely and jump to unstructured logic
      conversation.state = "unstructured";
    }

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

            // Record acceptance in user_terms
            await saveUserTerms(from, true);

            const resPending = await query(
              `SELECT data, data_translated, language FROM conversations WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );

            let pendingData = resPending.rows[0]?.data || [];
            let pendingDataTranslated = resPending.rows[0]?.data_translated || [];
            const responseLanguage = shouldUseEnglish ? 'en': resPending.rows[0]?.language || originalLanguage || 'en';
            console.log("responsLanguage", responseLanguage);

            let saveData = [...pendingData]; // copy for saving, does not include system prompt
            let saveDataTranslated = [...pendingDataTranslated];

            // Prepare AI input with system prompt (but do not save this in DB)
            const aiInput = [...pendingData, { role: "system", content: prompts.system_prompt }];

            const aiResponse = await getResponses(aiInput);

            if (aiResponse) {
              let messageText = aiResponse.text;
              console.log("AI Response before translation:", messageText);

              // Translate if conversation.language is not English
              if (responseLanguage && responseLanguage !== 'en') {
                const translated = await translateToSelectedLanguage(messageText, responseLanguage);
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
            //Have to send text first to stop errors
            await sendText(conversation.conversation_id, from, prompts.quit_response, botNumber);

            // Delete data
            await query(
              `DELETE FROM user_terms WHERE phone_number = $1`,
              [from]
            );

            await query(
              `DELETE FROM messages WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );

            await query(
              `DELETE FROM conversations WHERE conversation_id = $1`,
              [conversation.conversation_id]
            );
            
            return;
          }
        }

        // Terms not accepted yet: store pending message and send terms
        if (!conversation.terms_accepted) {
          const messageEnglish = messageForAI;
          const messageOriginal = body || "[Non-text message]";

          const dataArray = [{ role: "user", content: messageEnglish }];
          const dataTranslatedArray = [{ role: "user", content: messageOriginal }];

          const langToStore = shouldUseEnglish ? 'en' : detectedLanguage;

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
              langToStore, // the detected language code, e.g., "en" or "fr"
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
        const currentMessageLanguage = shouldUseEnglish ? 'en' : detectedLanguage;

        let saveData = [...pendingData]; // copy of conversation history
        let saveDataTranslated = [...pendingDataTranslated];

        if (!isReturningUserFirstMessage) {
          saveData.push({ role: "user", content: translatedText });
          saveDataTranslated.push({ role: "user", content: originalText });
        }

        // Add the new user message to both saveData and AI input
        // saveData.push({ role: "user", content: translatedText });
        // saveDataTranslated.push({ role: "user", content: originalText });

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
            if (currentMessageLanguage && currentMessageLanguage !== 'en') {
              const translated = await translateToSelectedLanguage(messageText, currentMessageLanguage);
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
              SET data = $1, data_translated = $2, language = $3, updated_time = NOW(), message_limit = $4 
              WHERE conversation_id = $5`,
              [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), currentMessageLanguage, userMessageCount + 1, conversation.conversation_id]
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
              SET data = $1, data_translated = $2, language = $3, updated_time = NOW(), state = 'structured', message_limit = $4 
              WHERE conversation_id = $5`,
              [JSON.stringify(saveData), JSON.stringify(saveDataTranslated), currentMessageLanguage, userMessageCount + 1, conversation.conversation_id]
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

            // Save the form response in first_message
            await query(
              `UPDATE conversations 
              SET first_message = $1, updated_time = NOW(), state = 'finish', expired_at = NOW()
              WHERE conversation_id = $2`,
              [JSON.stringify(savedData), conversation.conversation_id]
            );

            const botNumber = value?.metadata?.display_phone_number;

            // Thank the user
            await sendText(
              conversation.conversation_id,
              from,
              "✅ Thank you for submitting your impediment. You may submit another one at any time if needed.",
              botNumber
            );

            // console.log("📋 Form response saved and conversation finished:", savedData);

          } catch (err) {
            console.error("❌ Failed to parse form response JSON:", nfm.response_json, err.message);
          }

        } else {
          // Not a valid form response — send fallback message and end
          const botNumber = value?.metadata?.display_phone_number;

          await sendText(
            conversation.conversation_id,
            from,
            "⚠️ Sorry, I didn’t understand your response. The process has been closed. You can start again anytime if you’d like to submit another impediment. Thanks.",
            botNumber
          );

          await query(
            `UPDATE conversations 
            SET state = 'finish', updated_time = NOW(), expired_at = NOW() 
            WHERE conversation_id = $1`,
            [conversation.conversation_id]
          );

          // console.log("⚠️ Non-form response received — conversation ended.");
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
