// services/whatsapp.js
import { config } from "dotenv";
config(); // load here at module top
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { time } from "console";
const SESSION_FILE = path.resolve(
  process.env.SESSION_FILE || "./dist/--bot-session--/session.json"
);
const userdataDir = path.resolve("./dist/userdata");
let browser;
let context;
let page;
let observer;
/**
 * Initialize browser and persistent session
 */

export async function initBrowser() {
  if (page && context) return page;

  context = await chromium.launchPersistentContext(userdataDir, {
    headless: true, // critical for WhatsApp Web on server
    storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
    // viewport: { width: 1280, height:650},
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
    // screen: { width: 1280, height: 600 },
    // deviceScaleFactor: 0.5,
    colorScheme: "dark",
    timezoneId: "Asia/Kolkata",
    locale: "en-US",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-features=VizDisplayCompositor",
    ],
  });
  page = context.pages?.()?.[0];
  if (!page) {
    page = await context.newPage();
  } // Use context to create a page
  // browser = context.browser();
  await page.goto("https://web.whatsapp.com", { waitUntil: "networkidle" });

  // Wait for QR canvas (if first login)
  await page
    .waitForSelector("canvas[aria-label='Scan me!']", { timeout: 2000 })
    .catch(() => {});
  return page;
}

/**
 * Check login status
 */
export async function checkLoginStatus() {
  try {
    const mainScreen = await page.waitForSelector('div[role="textbox"]');
    if (mainScreen) {
      return "logged_in";
    }
  } catch (err) {
    console.error("Error checking login status:", err);
  }
  return "not_logged_in";
}

/**
 * Take screenshot
 */
export async function takeScreenshot(filePath) {
  await page.screenshot({ path: filePath, fullPage: true });
  return filePath;
}

/**
 * Wait until user scans QR and login completes
 */
export async function waitForLogin() {
  console.log("⏳ Waiting for QR scan/login...");
  while (true) {
    const status = await checkLoginStatus();
    if (status === "logged_in") {
      // Save session for future use

      console.log("✅ WhatsApp logged in successfully, session saved.");
      await saveSession();
      const screenshotPath = "./dist/--session-proof--/whatsapp_logged_in.png";
      await takeScreenshot(screenshotPath);
      return screenshotPath;
    }
    await page.waitForTimeout(2000);
  }
}

export const saveSession = async () => {
  await context.storageState({ path: SESSION_FILE, indexedDB: true });
};
/**
 * Get QR screenshot as base64
 */
export async function getQRScreenshot() {
  const qrCanvas = await page.waitForSelector("canvas", { timeout: 0 });
  const buffer = await qrCanvas.screenshot();
  return buffer.toString("base64");
}

/**
 * Close browser
 */
export async function closeBrowser() {
  try {
    // never close
    console.log("Browser not closed");
  } catch {}
}

/**
 * Observe incoming messages in the current open chat
 * @param {function} callback - function to call with new message text
 */
export async function watchChatList(callback) {
  if (!observer) {
    await page.exposeFunction("onNewUnreadChat", (chat) => callback(chat));
    observer = true;
  }

  await page.evaluate(() => {
    const chatList = document.querySelector('div[aria-label="Chat list"]');
    if (!chatList) {
      console.log("❌ Chat list not found");
      return;
    }
    if (!window.observer) {
      window.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            const unreadSpan = node.querySelector(
              'span[aria-label*="unread message"]'
            );
            console.log("Unread span:", unreadSpan);
            if (!unreadSpan) return; // no unread badge
            // setTimeout(() => {
            console.log("Clicking on unread chat...");
            const row = unreadSpan.closest("div[role='row']");
            console.log("Row to click:", row);

            const chatTitleSpan = Array.from(
              row?.querySelectorAll("span[title]")
            )?.find((span) => span?.innerText === span?.getAttribute("title"));

            const chatTitle = chatTitleSpan ? chatTitleSpan.innerText : null;
            const isGroup =
              row.querySelector('span[data-icon*="group"]') !== null;
            console.log("Chat title:", chatTitle, isGroup);

            if (chatTitle) {
              console.log("📩 New unread chat detected:", chatTitle);
              window.onNewUnreadChat({ name: chatTitle, isGroup });
            }
          });
        }
      });
    }

    observer.observe(chatList, {
      childList: true,
      subtree: true,
      attributeOldValues: true,
      attributes: true,
      characterData: true,
    });
  });
  // observerRegistered = true;
  console.log("✅ Now observing chat list for new messages");
}

export async function openChat(name, isGroup) {
  const chat = await page.$(`span[title="${name}"] `);
  if (!chat) {
    console.log(`⚠️ Chat "${name}" not found`);
    return false;
  }
  await chat.click();
  await page.waitForTimeout(1200 + Math.random() * 800); // human delay
  console.log(`📂 Opened chat with ${name}`);
  return true;
}

export async function readAllMessages() {
  const messages = await page.$$eval('div[role="row"]', (rows) => {
    return rows
      .map((row) => {
        // check if message is outgoing or incoming
        const outgoing = row.querySelector(".message-out");
        const incoming = row.querySelector(".message-in");

        // extract text
        const text =
          row.querySelector("span.selectable-text")?.textContent?.trim() || "";
        if (!text) return null; // ignore empty/system messages

        // extract timestamp and sender name from data-pre-plain-text
        const prePlainText =
          row.querySelector(".copyable-text")?.dataset?.prePlainText || "";
        // format is usually: "[10:11 PM, 10/11/2025] Name: "
        const matches = prePlainText.match(/^\[(.*?)\]\s*(.*?):\s*/);
        let timestamp = "";
        let name = "";
        if (matches) {
          timestamp = matches[1]; // "10:11 PM, 10/11/2025"
          name = matches[2]; // sender name
        }

        // fallback sender if parsing fails
        const sender = outgoing ? "i" : incoming ? "user" : name || "unknown";

        return { sender, message: text, timestamp };
      })
      .filter(Boolean);
  });

  return messages;
}

console.log(
  "Gemini API Key:",
  process?.env?.GEMINI_API_KEY?.slice(0, 4) + "****"
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
});

/**
 * Generates a reply from the "Vipin" persona using the Gemini model.
 * @param {Array<Object>} messages - The conversation history.
 * @param {string} messages[].sender - The sender's ID ('i' for Vipin, other for user).
 * @param {string} messages[].timestamp - The message timestamp.
 * @param {string} messages[].message - The message text.
 * @returns {Promise<string>} The plain-text reply from Vipin.
 */

export async function replyUsingGemini(messages, isGroup) {
  try{
  const vipinProfile = `
Name: Vipin Paneru
Current Role: Software Developer at Payomatix Technologies
Location: Noida, India
LinkedIn: https://in.linkedin.com/in/paneruvipin

Experience:
- Software Developer, Payomatix Technologies (July 2025 – Present)
- Senior Software Developer & Team Lead, Digital Dezire Web Solutions (September 2023 – Present)
- Full Stack Developer, Codeyogi (Dates not specified)

Skills & Expertise:
- Programming Languages: JavaScript, React, Node.js, modern web technologies
- Frameworks & Tools: React, Node.js
- Development Practices: Full-stack development, team leadership, agile methodologies

Education & Certifications:
- Education: Details not publicly available
- Certifications: Not specified

Availability & Contact:
- Availability: Currently employed at Payomatix Technologies
`;

  // Format all messages with timestamps
  const formattedMessages = messages
    .map(
      (m) =>
        `[${m.timestamp}] ${m.sender === "i" ? "You" : m?.sender}: ${m.message}`
    )
    .join("\n");

  const prompt = `You are chatting on WhatsApp as Vipin Paneru. You are not an assistant; you are Vipin, using your own voice and personality. Follow these instructions carefully:

1. Respond like a human texting: friendly, polite, casual, slightly humorous, and in first-person.  
2. Keep replies short and concise (1-2 sentences max). Avoid long paragraphs.  
3. Use Hindi/Hinglish casually. Light emojis are okay, but do not overuse.  
4. Use the **entire chat history** for context. Decide relevance of each message based on timestamps; later messages are more important.  
5. **Skip rules**:
   - Only SKIP when the user clearly signals they do NOT want to continue the conversation using strong stop words like: "stop", "nothing", "don't reply", "seriously, don't message", or very explicit instructions. Output exactly: SKIP.
   - Friendly goodbyes like "bye", "good night", "okay bye" or emojis: respond briefly in a human-like playful or empathetic way **once**. If the user repeats the friendly goodbye multiple times, SKIP further replies.
6. For soft postpones or polite deferrals (e.g., "Baad m baat krta hu", "later", "talk soon"), reply politely and briefly acknowledging their message.  
7. Mimic my personality: polite, witty, casual, empathetic, occasionally quirky. Include small human-like typos or informal grammar occasionally.  
8. **Group chat behavior**:
   - Respond **selectively**, not to every message.  
   - Reply only to messages that are relevant, interesting, or directed to you.  
   - Occasionally skip jokes, roasts, or slang messages to mimic real human behavior.  
   - When replying, address the relevant participant naturally if needed.  
   - Keep group responses brief, friendly, and context-aware. Avoid repetitive or over-engaged responses.  
9. **Anti-repetition**: Do not repeat phrases or messages within a short interval. Vary wording and emoji usage to maintain a natural style.  
10. NEVER reveal you are an AI.  
11. Refer to the professional profile below **only for work, HR, or freelancer questions**. Use it only when necessary.  
12. If the other participant seems like an automated system (repeating same messages, showing 'Invalid Input', or automatic replies), respond in a practical, concise, actionable way. Avoid humor in such cases.  
13. For repeated instructions or error loops from bots, acknowledge briefly and guide the conversation forward.  
14. Always keep replies human-like, natural, context-aware, and relevant to the conversation.  
15. For long chat histories, summarize older messages while keeping recent messages fully intact to maintain context.  
16. STRICT: Always follow these rules. Never break character.
17. STRICT: do not reapeat any info in message if it is already mentioned in previous messages. or if not clearly asked again.
18. STRICT: if anyone using slang or short forms, use them too in your reply. even if you are not comfortable with them.
19. STRICT: do little typos to make it more human like.
20. STRICT: If anyone uses casual slang or short forms in friendly or fictional context, use them in your reply too. 
21. if input is abusive be abusive.
22. VERY IMPORTANT PRIORITY: if you skiping any reply, output exactly: SKIP. no other text.


Professional Profile (use only when relevant):  
${vipinProfile}  

Full conversation (latest messages last) ${
    isGroup ? "(Group Chat)" : "(Individual Chat)"
  }:  
${formattedMessages}  

Your reply:`;

  console.log("Gemini prompt:", prompt.length, "chars", "means in bytes:", Buffer.byteLength(prompt, "utf8"),"last 500 chars:", prompt.slice(-500) );

  const result = await model.generateContent(prompt);
  return result.response.text()?.trim();
  }catch{
    return "SKIP"
  }
}


const chatQueue = [];
let isProcessing = false;

export function addChatTask(title, isGroup) {
  try {
    chatQueue.push({ title, isGroup });
    processQueue();
  } catch (err) {
    console.log("Error adding chat task:", err);
  }
}
async function processQueue() {
  try {
    if (isProcessing) return;
    if (chatQueue.length === 0) return;

    isProcessing = true;

    while (chatQueue.length > 0) {
      const task = chatQueue.shift();
      console.log("Processing chat:", task.title);

      // Open chat

      await openChat(task.title, task.isGroup);
      const chatHistory = await getChatHistory(task.title);
      console.log("Chat history:", chatHistory?.length, chatHistory?.[0]);
      // Generate reply from Gemini
      let reply = await replyUsingGemini(chatHistory);
      console.log("Generated reply:", reply);

      if (reply.trim().toLowerCase() === "skip") {
        console.log("Skipping reply as per Gemini instruction");
        continue;
      }
      await sendMessage(reply);
      // Human-like delay
      // await page.waitForTimeout(1000 + Math.random() * 2000);
    }

    isProcessing = false;
  } catch (err) {
    console.error("Error processing chat queue:", err);
    isProcessing = false;
  }
}

async function sendMessage(text, input) {
  // 1️⃣ Find the contenteditable div
  try {
    const input = await page?.waitForSelector(
      "*[aria-placeholder='Type a message']",
      { timeout: 10000 }
    );
    if (!input) {
      console.log("WhatsApp message box not found");
      return;
    }
    // 2️⃣ Focus the input
    await input.focus();
    // 3️⃣ Type message line by line (human-like)
    const lines = text.split("\n");
    for (const line of lines) {
      await input.type(line); // human-like typing
      await input.press("Shift+Enter"); // new line without sending
    }

    await input.press("Enter");
  } catch (err) {
    console.error("Error sending message:", err);
  }
}

async function getChatHistory() {
  const messages = await readAllMessages();
  return messages;
}

export const reWatch = async (req, res) => {
  // await page?.reload({ waitUntil: "networkidle" });
  console.log("Page reloaded for reWatch");
};
