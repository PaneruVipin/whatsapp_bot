import { config } from "dotenv";
config();
import express from "express";
import fs from "fs";
import path from "path";
import {
  initBrowser,
  checkLoginStatus,
  takeScreenshot,
  waitForLogin,
  getQRScreenshot,
  watchChatList,
  addChatTask,
  reWatch,
} from "./services/whatsapp.js";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/check-login", async (req, res) => {
  try {
    const { poll } = req?.query || {};
    const page = await initBrowser();
    const status = await checkLoginStatus();

    if (status === "logged_in") {
      // Already logged in → return screenshot
      const screenshotPath = path.resolve(
        "../dist/--session-proof--/whatsapp_already_logged.png"
      );
      await takeScreenshot(screenshotPath);
      const screenshotBase64 = fs.readFileSync(screenshotPath, {
        encoding: "base64",
      });

      res
        .status(200)
        .send("<img src='data:image/png;base64," + screenshotBase64 + "' />");
    } else if (poll) {
      return res.status(401).send("Not logged in");
    } else {
      // Not logged in → return QR
       await reWatch();
      const qrBase64 = await getQRScreenshot();
      // Send initial QR code UI
      res.status(303).send(`
        <html>
          <body>
        <div id="content">
          <h2>Scan this QR code with WhatsApp</h2>
          <img id="qr" src="data:image/png;base64,${qrBase64}" />
          <div id="status">Waiting for login...</div>
        </div>
        <script>
          // Poll the server every 1 seconds to check login status
          const interval = setInterval(async () => {
            console.log("Checking login status...");
        const resp = await fetch('/check-login?poll=1');
        console.log("Response status:", resp.status,resp);
        const data = await resp.text();
        if (resp.status === 200) {
          document.getElementById('content').innerHTML = data;
          clearInterval(interval);
        }

          }, 3000);
        </script>
          </body>
        </html>
      `);

      // Wait in background for login to complete and save session
      waitForLogin()
        .then((finalScreenshot) => {
          console.log(
            "✅ WhatsApp logged in and session saved:",
            finalScreenshot
          );
          // Optionally notify client via WebSocket or another API
          watchChatList(async (messageText) => {
            addChatTask(messageText?.name);
            console.log("New message received:", messageText);
          }).then(() => {
            console.log("✅ Now observing messages");
          });
        })
        .catch((err) => console.error("❌ Error during login:", err));
    }
  } catch (error) {
    console.error("❌ Error during /check-login:", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/re-watch", reWatch);
const PORT = process.env.PORT || 8080;
app.listen(PORT,'0.0.0.0', () => console.log(`🚀 Server running on port ${PORT}`));

