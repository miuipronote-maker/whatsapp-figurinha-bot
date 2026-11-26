
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage
} from "@whiskeysockets/baileys";

import P from "pino";
import qrcode from "qrcode-terminal";
import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const TEMP_DIR = path.join(os.tmpdir(), "figurinha-bot");

fs.mkdirSync(TEMP_DIR, { recursive: true });

async function processVideo(input, output) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", input,
    "-t", "12",
    "-vf",
    "scale=720:720:force_original_aspect_ratio=increase,crop=720:720,fps=30",
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output
  ]);
}

async function downloadLink(url, output) {
  await execFileAsync("yt-dlp", [
    "--no-playlist",
    "--max-filesize", "100M",
    "--match-filter", "duration <= 600",
    "-f", "best[ext=mp4]/best",
    "-o", output,
    url
  ]);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");

  const sock = makeWASocket({
    auth: state,
    logger: P({ level: "silent" }),
    browser: ["Figurinha Bot", "Chrome", "1.0.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("Leia o QR Code para conectar o WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "open") {
      console.log("Bot conectado ao WhatsApp!");
    }

    if (connection === "close") {
      const status = lastDisconnect?.error?.output?.statusCode;

      if (status !== DisconnectReason.loggedOut) {
        console.log("Conexão perdida. Reconectando...");
        startBot();
      } else {
        console.log("Sessão encerrada. É necessário conectar novamente.");
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const chat = msg.key.remoteJid;

      if (!chat || chat.endsWith("@g.us") === false && chat === "status@broadcast") {
        continue;
      }

      const message =
        msg.message.ephemeralMessage?.message ||
        msg.message.viewOnceMessage?.message ||
        msg.message;

      const video = message.videoMessage;
      const text =
        message.conversation ||
        message.extendedTextMessage?.text ||
        "";

      const url = text.match(/https?:\/\/[^\s]+/i)?.[0];

      if (!video && !url) continue;

      const id = randomUUID();
      const input = path.join(TEMP_DIR, `${id}_input.mp4`);
      const output = path.join(TEMP_DIR, `${id}_output.mp4`);

      try {
        await sock.sendMessage(chat, {
          text: "⏳ Recebi! Estou preparando sua figurinha em vídeo..."
        });

        if (video) {
          const buffer = await downloadMediaMessage(
            msg,
            "buffer",
            {},
            { logger: P({ level: "silent" }) }
          );

          fs.writeFileSync(input, buffer);
        } else {
          await downloadLink(url, input);
        }

        await processVideo(input, output);

        const result = fs.readFileSync(output);

        await sock.sendMessage(chat, {
          video: result,
          mimetype: "video/mp4",
          caption: "✅ Sua figurinha em vídeo está pronta!"
        }, { quoted: msg });

      } catch (error) {
        console.error("Erro ao processar:", error);

        await sock.sendMessage(chat, {
          text: "❌ Não consegui processar esse vídeo. Tente enviar outro arquivo ou link público compatível."
        });
      } finally {
        for (const file of [input, output]) {
          if (fs.existsSync(file)) {
            fs.unlinkSync(file);
          }
        }
      }
    }
  });
}

startBot().catch(console.error);
