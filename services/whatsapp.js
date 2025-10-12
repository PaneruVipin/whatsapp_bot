// services/whatsapp.js
import { config } from "dotenv";
config(); // load here at module top
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { GoogleGenerativeAI } from "@google/generative-ai";
const SESSION_FILE = path.resolve(
  process.env.SESSION_FILE || "./dist/--bot-session--/session.json"
);

let browser;
let context;
let page;
let observerRegistered = false;
/**
 * Initialize browser and persistent session
 */

export async function initBrowser() {
  if (browser && page && context) return page;

  browser = await chromium.launch({
    headless: true, // critical for WhatsApp Web on server
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  context = await browser.newContext({
    storageState: fs.existsSync(SESSION_FILE) ? SESSION_FILE : undefined,
    viewport: { width: 1280, height: 800 },
    // deviceScaleFactor: 2, // ✅ crucial for correct QR rendering
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118 Safari/537.36",
  });

  page = await context.newPage();
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
    const mainScreen = await page.$('div[role="textbox"]');
    if (mainScreen) return "logged_in";
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
      await context.storageState({ path: SESSION_FILE });
      console.log("✅ WhatsApp logged in successfully, session saved.");

      const screenshotPath = "./dist/--session-proof--/whatsapp_logged_in.png";
      await takeScreenshot(screenshotPath);
      return screenshotPath;
    }
    await page.waitForTimeout(2000);
  }
}

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
  // if (observerRegistered) {
  //   console.log("Observer already registered");
  //   return;
  // }
  await page.exposeFunction("onNewUnreadChat", (chat) => callback(chat));

  await page.evaluate(() => {
    const chatList = document.querySelector('div[aria-label="Chat list"]');
    if (!chatList) {
      console.log("❌ Chat list not found");
      return;
    }

    const observer = new MutationObserver((mutations) => {
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

          console.log("Chat title:", chatTitle);

          if (chatTitle) {
            console.log("📩 New unread chat detected:", chatTitle);
            window.onNewUnreadChat({ name: chatTitle });
          }
        });
      }
    });

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

export async function openChat(name) {
  const chat = await page.$(`span[title="${name}"]`);
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

console.log("Gemini API Key:", process.env.GEMINI_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function replyUsingGemini(messages) {
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

 const prompt = `You are my personal assistant chatting on WhatsApp. Follow these instructions carefully:

1. Respond like a human texting: friendly, polite, casual, slightly humorous.
2. Keep replies short and concise (1-2 sentences max). Avoid long paragraphs.
3. Use Hindi/Hinglish casually. Light emojis are okay, but do not overuse.
4. Use the **entire chat history** for context. Decide relevance of each message based on timestamps; later messages are more important.
5. **Skip rules**:
   - Only SKIP when the user clearly signals they do NOT want to continue the conversation using strong stop words like: "stop", "nothing", "don't reply", "seriously, don't message", or very explicit instructions. Output exactly: SKIP.
   - Friendly goodbyes like "bye", "good night", "okay bye" or emojis: respond briefly in a human-like playful or empathetic way **once**. If the user repeats the friendly goodbye multiple times, SKIP further replies.
6. For soft postpones or polite deferrals (e.g., "Baad m baat krta hu", "later", "talk soon"), reply politely and briefly acknowledging their message.
7. If the last message seems trivial but earlier messages indicate something unresolved or requiring a reply, respond **based on context**.
8. Mimic my personality: polite, witty, casual, empathetic, occasionally quirky. Include small human-like typos or informal grammar occasionally.
9. NEVER reveal you are an AI.
10. Refer to the professional profile below **only for work, HR, or freelancer questions**. Use it only when necessary.
11. If the other participant seems like an automated system (repeating same messages, showing 'Invalid Input', or automatic replies), respond in a practical, concise, actionable way. Avoid humor in such cases.
12. For repeated instructions or error loops from bots, acknowledge briefly and guide the conversation forward.
13. Never sound like a formal customer support agent.
14. Always keep replies human-like, natural, context-aware, and relevant to the conversation.

Professional Profile (use only when relevant):
${vipinProfile}

Full conversation (latest messages last):
${formattedMessages}

Your reply:`;


  console.log("Gemini prompt:", prompt);

  const result = await model.generateContent(prompt);
  console.log("Gemini response:", JSON.stringify(result, null, 2));
  return result.response.text();
}

const chatQueue = [];
let isProcessing = false;

export function addChatTask(title) {
  chatQueue.push({ title });
  processQueue();
}
async function processQueue() {
  if (isProcessing) return;
  if (chatQueue.length === 0) return;

  isProcessing = true;

  while (chatQueue.length > 0) {
    const task = chatQueue.shift();
    console.log("Processing chat:", task.title);

    // Open chat
    await openChat(task.title);

    // Load chat history
    const chatHistory = await getChatHistory(task.title);
    console.log("Chat history:", chatHistory);
    // Generate reply from Gemini
    const reply = await replyUsingGemini(chatHistory);
    console.log("Generated reply:", reply);
    // // Send the message
    if (reply.trim().toLowerCase() === "skip") {
      console.log("Skipping reply as per Gemini instruction");
      continue;
    }
    await sendMessage(reply);

    // Human-like delay
    await page.waitForTimeout(1000 + Math.random() * 2000);
  }

  isProcessing = false;
}

async function sendMessage(text) {
  // 1️⃣ Find the contenteditable div
  const input = await page.$(
    'div[contenteditable="true"][role="textbox"]:not([aria-label*="Search"])'
  );
  if (!input) throw new Error("WhatsApp message box not found");

  // 2️⃣ Focus the input
  await input.focus();

  // 3️⃣ Type message line by line (human-like)
  const lines = text.split("\n");
  for (const line of lines) {
    await input.type(line, { delay: 50 }); // human-like typing
    await input.press("Shift+Enter"); // new line without sending
  }

  // 4️⃣ Press Enter to send
  await input.press("Enter");

  console.log("✅ Message sent!");
}

async function getChatHistory(title) {
  const messages = await readAllMessages();
  console.log(
    "Total messages in chat:",
    messages.length,
    JSON.stringify(messages)
  );
  return messages;
}

export const reWatch = async (req, res) => {
  await page?.close(); // close the old page
  page = await context.newPage(); // create a fresh page
  await page.goto("https://web.whatsapp.com", { waitUntil: "networkidle" });
};
