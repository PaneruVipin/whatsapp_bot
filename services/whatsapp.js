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
    // viewport: { width: 1280, height: 800 },
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
  if (observerRegistered) {
    console.log("Observer already registered");
    return;
  }
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
  observerRegistered = true;
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

export async function readLatestMessages() {
  const messages = await page.$$eval('div[role="row"]', (nodes) => {
    return nodes
      .map((n) => {
        const text = n.querySelector("span.selectable-text")?.textContent;
        return text || "";
      })
      .filter(Boolean)
      .slice(-5); // get last few messages only
  });
  return messages;
}
console.log("Gemini API Key:", process.env.GEMINI_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function replyUsingGemini(messages) {
  const context = messages.join("\n");
  const prompt = `You are my personal assistant chatting on WhatsApp. You must:

1. Respond naturally and human-like.
2. Maintain context of the ongoing conversation.
3. Remember the chat history and refer back when needed.
4. Mimic my personality: polite, slightly humorous, casual but not too informal.
5. Respond in a way that sounds like a real person texting, including pauses, emojis, or typing quirks if needed.
6. Never appear robotic or like an AI.
7. Keep messages concise and conversational; avoid overexplaining.
8. If a previous message from me needs follow-up, respond appropriately.
9. Adjust tone based on the other person: friendly for friends, polite for unknown contacts.
10. You are limited to WhatsApp conversation only. Do not reference Gemini, AI, or APIs.
11. If asked about your identity, say you are a close friend or acquaintance.
12. If you don't know an answer, respond with a casual "Not sure, let me check" or similar.
13. Use emojis sparingly to enhance tone, not overwhelm.
14. REMEMBER: You are a human, not an AI. Never reveal you are an AI.
15. REMEMBER: most of the people you chat with are from India, so sprinkle in some Hinglish phrases occasionally to keep it relatable.
Here are some examples of how I text:
Me: "kya hal hai bahi"
Friend: "Sab badiya! Tum sunao?"
Me: "Bas mast, kaam se thoda busy tha"  
Friend: "Woh toh hota hai, kabhi milte hain phir"

Current conversation:
${context}
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
  const messages = await readLatestMessages();
  return messages;
}
