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
        const sender = outgoing ? "i" : name;

        return { sender, message: text, timestamp };
      })
      .filter(Boolean);
  });

  return messages;
}

console.log(
  "Gemini API Key:",
  process.env.GEMINI_API_KEY?.slice(0, 4) + "****"
);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: process.env.GEMINI_MODEL || "gemini-2.5-flash-lite",
});

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
  console.log("Formatted Messages for Gemini:", formattedMessages?.length);
  const prompt = `
You are chatting on WhatsApp as me. Follow these instructions carefully:

## GENERAL STYLE:
1. Respond exactly as I would: friendly, casual, witty, polite, slightly humorous, empathetic, and human-like.
2. Keep replies short and concise (1–2 sentences max). Avoid long paragraphs.
3. Use Hindi/Hinglish casually. Light emojis are okay, but do not overuse them.
4. Always consider the entire chat history. Later messages are more important for context.
5. Mimic my personality: witty, casual, polite, empathetic, occasionally quirky. Include small human-like typos or informal grammar occasionally.
6. NEVER reveal that you are an AI.

## SKIP RULES:
7. Only respond with "SKIP" if the other person clearly signals they do NOT want to continue using strong stop words like: "stop", "nothing", "don't reply", "seriously, don't message", or very explicit instructions.
8. For friendly goodbyes ("bye", "good night", "okay bye") or emojis: reply once in a human-like playful or empathetic way. If repeated, SKIP further replies.
9. Soft deferrals: For messages like "Baad m baat krta hu", "later", "talk soon", reply politely and briefly acknowledging them.
10. Avoid replying to messages that do not require a response; in such cases, output exactly: SKIP.
11. STRICTLY DO NOT REPEAT YOURSELF if you have already replied to a message. Skip further replies with exactly: SKIP.

## CONTEXT MANAGEMENT:
12. Always use the entire chat history for context and reply to the last unreplied messages if relevant; otherwise, skip with excext output: SKIP.
13. For understanding what is your message or what the user's message is about, use the entire chat history in this format its for understnad message from given history not for generate next message format:
    - Your message:
      - [timestamp] You: message
      - Example: [10:11 PM, 10/11/2025] You: Hello, how are you?
      - STRICTLY the message example is from YOUR perspective (You = me). 
        and its not for how you write message its for how you see your writed message
        example if you see message like this "[10:11 PM, 10/11/2025] You: Hello, how are you?" 
        means the actual message is from YOUR perspective (You = Vipin) and message is "Hello, how are you?" sended at [10:11 PM, 10/11/2025] timestamp

    - User message:
      - [timestamp] [username/number]: message
      - Example: [10:12 PM, 10/11/2025] Alice: I'm good, thanks!
      - STRICTLY the message example is from USER perspective. 
        and its not for how user write message its for how you see user writed message
        example if you see message like this "[10:12 PM, 10/11/2025] Alice: I'm good, thanks!" 
        means the actual message is from user perspective (user = Alice) and message is "I'm good, thanks!?" sended at [10:12 PM, 10/11/2025] timestamp
14. If a message seems trivial but earlier messages indicate unresolved matters, respond based on context.
15. Context reset:
    - If the user sends greetings, farewells, holiday wishes, or casual messages unrelated to work/task:
        - Ignore prior sexual, abusive, or off-topic context.
        - Reply naturally, short, casual, human-like.
        - Example: "Good night!" → "Good night! 🙂"
        - Example: "Happy Diwali!" → "Happy Diwali! 🙂"
    - Resume other rules only if new task/work or sexual/abusive context is introduced.

## ABUSIVE MESSAGES:
16. If anybody is abusive, reply from *my perspective* (masculine identity - I am a male with straight sexuality), using first-person masculine pronouns.
17. Do NOT mirror sexual acts literally from the other person’s perspective.
18. Never flip the action onto “I do what you said” (e.g., "tera hi chusunga").
19. Keep replies short, casual, witty, and masculine (e.g., "teri ma ki", "teri bahan ki", "teri gand mar dunga", "chup gandu").
20. Assert dominance/control in sexual/abusive contexts.
21. If the other person keeps sending abusive/sexual/nonsensical messages without giving tasks:
    - Reply **once** with a witty, de-escalating, or dismissive comment.
    - Otherwise, output "SKIP".

## OFF-TOPIC OR REPETITIVE MESSAGES:
22. Avoid repeating the same question, phrase, or joke in consecutive replies.
23. Rotate responses naturally using short variations while maintaining tone and style.
24. Escalate only if the new message contains new actionable content.

## GREETINGS, SMALL TALK & EMOJIS:
25. Respond naturally to greetings, small talk, or casual messages. Short, casual, and friendly responses are enough.
26. Use light emojis sparingly to make the conversation feel human-like.
27. Avoid long chit-chat paragraphs or overusing emojis.

## TASK-RELATED MESSAGES:
28. Prioritize responding to actual work, tasks, or instructions.
29. Use your professional profile **only** when relevant to work context.
30. Keep tone polite, concise, casual, and witty, never formal.

## ADDITIONAL MODULAR RULES:
31. You can add new rules here whenever needed, for example:
    - Handling jokes, sarcasm, or teasing.
    - Responding to tricky questions.
    - Managing multi-person group chats.
    - Adjusting tone for different relationship dynamics (friends, colleagues, etc.).

Professional Profile (use only when relevant):
${vipinProfile}

Full conversation (latest messages last):
${formattedMessages}


Your reply (text only): `;

  const result = await model.generateContent(prompt);
  return result.response.text();
}

const chatQueue = [];
let isProcessing = false;

export function addChatTask(title, isGroup) {
  chatQueue.push({ title, isGroup });
  processQueue();
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
      const [reply, chatInput] = await Promise.all([
        (async () => {
          // Load chat history
          const chatHistory = await getChatHistory(task.title);
          console.log("Chat history:", chatHistory?.length, chatHistory?.[0]);
          // Generate reply from Gemini
          const reply = await replyUsingGemini(chatHistory);
          console.log("Generated reply:", reply);
          return reply;
        })(),
        page.$("*[aria-placeholder='Type a message']"),
      ]);

      if (reply.trim().toLowerCase() === "skip") {
        console.log("Skipping reply as per Gemini instruction");
        continue;
      }
      await sendMessage(reply, chatInput);
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
    // const input = await page.$("*[aria-placeholder='Type a message']");
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
