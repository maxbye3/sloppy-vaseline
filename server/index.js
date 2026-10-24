import express from "express";
import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Server } from "socket.io";
import sharp from "sharp";
import { Room } from "./game.js";
import { generateResponse } from "./ai.js";

export function createApp({ generate = generateResponse, durations } = {}) {
  const app = express();
  const http = createServer(app);
  const io = new Server(http, { maxHttpBufferSize: 7 * 1024 * 1024 });
  const rooms = new Map();
  const sessions = new Map();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });
  app.get("/health", (_req, res) => res.json({ ok: true }));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url))));
  function broadcast(room) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.data.room === room.code)
        socket.emit("state", room.state(socket.data.player));
    }
  }
  io.on("connection", (socket) => {
    let count = 0;
    let windowStart = Date.now();
    let joining = false;
    const guarded = (event, fn) =>
      socket.on(event, async (payload, ack = () => {}) => {
        if (typeof ack !== "function") ack = () => {};
        try {
          if (Date.now() - windowStart > 10000) {
            count = 0;
            windowStart = Date.now();
          }
          if (++count > 100)
            throw new Error("Too many requests. Wait a moment.");
          await fn(payload || {});
          ack({ ok: true });
        } catch (err) {
          ack({ ok: false, error: err.message || "Something went wrong." });
        }
      });
    guarded("join", async ({ code, name, image, token, create }) => {
      if (joining || socket.data.room)
        throw new Error("You have already joined a room.");
      joining = true;
      try {
        if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token))
          throw new Error("Invalid session. Reload the page.");
        name =
          typeof name === "string"
            ? [...name.trim()].slice(0, 24).join("")
            : "";
        if (!name) throw new Error("Enter your name.");
        code =
          typeof code === "string" ? code.toUpperCase().replace(/\s/g, "") : "";
        if (create) {
          if (rooms.size >= 500)
            throw new Error("The server is full. Please try later.");
          const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
          do {
            code = Array.from(
              { length: 6 },
              () => alphabet[randomInt(alphabet.length)],
            ).join("");
          } while (rooms.has(code));
        }
        if (!/^[A-Z2-9]{6}$/.test(code))
          throw new Error("Enter a six-character room code.");
        const existing = rooms.get(code);
        if (!existing && !create)
          throw new Error("Room not found. Check your code or create a room.");
        const sessionKey = `${code}:${token}`;
        let id = sessions.get(sessionKey);
        let avatar = "";
        if (!id && image) {
          if (
            typeof image !== "string" ||
            image.length > 7e6 ||
            !/^data:image\/(jpeg|png|webp);base64,/.test(image)
          )
            throw new Error("Choose a JPEG, PNG, or WebP image under 5 MB.");
          const buffer = Buffer.from(image.split(",")[1], "base64");
          if (buffer.length > 5 * 1024 * 1024)
            throw new Error("Image must be under 5 MB.");
          try {
            const img = sharp(buffer, { limitInputPixels: 25000000 });
            const info = await img.metadata();
            if (!["jpeg", "png", "webp"].includes(info.format))
              throw new Error();
            avatar =
              "data:image/webp;base64," +
              (
                await img
                  .rotate()
                  .resize(128, 128, { fit: "cover" })
                  .flatten({ background: "#fff" })
                  .grayscale()
                  .webp({ quality: 75 })
                  .toBuffer()
              ).toString("base64");
          } catch {
            throw new Error(
              "This image could not be read. Choose another image.",
            );
          }
        }
        if (!socket.connected) return;
        const room = existing || new Room(code, generate, broadcast, durations);
        id ||= randomUUID();
        // Connect first so a rejected join cannot leave a socket attached to a room.
        room.connect(id, name, avatar);
        rooms.set(code, room);
        sessions.set(sessionKey, id);
        socket.data.room = code;
        socket.data.player = id;
        // A reconnect takes over the session so two tabs cannot submit as one player.
        for (const other of io.sockets.sockets.values()) {
          if (
            other.id !== socket.id &&
            other.data.room === code &&
            other.data.player === id
          ) {
            other.data.room = null;
            other.emit("replaced");
            other.disconnect(true);
          }
        }
        broadcast(room);
      } finally {
        joining = false;
      }
    });
    for (const [event, method] of Object.entries({
      start: "begin",
      next: "begin",
      scenario: "setScenario",
      submit: "submit",
      vote: "vote",
      leaderboard: "advance",
      end: "end",
      again: "again",
      draft: "draft",
    })) {
      guarded(event, (data) => {
        const room = rooms.get(socket.data.room);
        if (!room) throw new Error("Join a room first.");
        room[method](
          socket.data.player,
          event === "vote" ? data.id : data.text,
        );
      });
    }
    socket.on("disconnect", () =>
      rooms.get(socket.data.room)?.disconnect(socket.data.player),
    );
  });
  const cleanup = setInterval(() => {
    for (const [code, room] of rooms) {
      if (
        Date.now() - room.touched > 2 * 60 * 60 * 1000 &&
        ![...room.players.values()].some((p) => p.connected)
      ) {
        room.destroy();
        rooms.delete(code);
        for (const key of sessions.keys())
          if (key.startsWith(`${code}:`)) sessions.delete(key);
      }
    }
  }, 60000);
  cleanup.unref();
  return {
    app,
    http,
    io,
    rooms,
    close: async () => {
      clearInterval(cleanup);
      for (const room of rooms.values()) room.destroy();
      await new Promise((resolve) => io.close(resolve));
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { http } = createApp();
  const port = Number(process.env.PORT) || 3000;
  http.listen(port, "0.0.0.0", () =>
    console.log(`Slop or Human listening on port ${port}`),
  );
}
