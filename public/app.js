/* The browser renders only the private state sent to this session. */
const app = document.querySelector("#app");
const socket = io({ autoConnect: true });
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const EXAMPLES = [
  "Self-performance evaluation",
  "A critical analysis of Monday's free lunch",
  "Proposal for Celsius to be returned to the drinks fridge",
  "A love letter",
  "Message to the company that snacks are unavailable",
  "A pull request description for changing one character",
  "A heartfelt apology for eating someone else's lunch",
  "A justification for spending $400 in API credits to save five minutes",
  "A LinkedIn post about overcoming the adversity of a delayed train",
];
let stored;
try {
  stored = JSON.parse(localStorage.getItem("slop-session"));
} catch {
  /* A new session is fine. */
}
let token =
  stored?.token ||
  [...crypto.getRandomValues(new Uint8Array(32))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
let state = null;
let mode = new URLSearchParams(location.search).has("room") ? "join" : "create";
let profileImage = "";
let selected = null;
let localDraft = "";
let scenarioDraft = "";
let lastRound = null;
let clockOffset = 0;
let selectorTimer;
let draftTimer;
let rejoining = false;
let errorTimer;
let lastRenderedKey = "";
let savedName = stored?.name || "";
let lobbyMusic;
let musicRequested = false;
let musicAttempt = 0;

function updateMusicButton() {
  const button = $("#lobby-music");
  if (!button) return;
  button.textContent = musicRequested
    ? "Pause the Terminator theme"
    : "Play the Terminator theme while you wait?";
  button.setAttribute("aria-pressed", String(musicRequested));
}
function pauseLobbyMusic() {
  musicAttempt++;
  musicRequested = false;
  lobbyMusic?.pause();
  updateMusicButton();
}
function toggleLobbyMusic() {
  if (state?.phase !== "lobby") return;
  if (musicRequested) return pauseLobbyMusic();
  if (!lobbyMusic) {
    lobbyMusic = new Audio();
    lobbyMusic.preload = "none";
    lobbyMusic.loop = true;
    lobbyMusic.src = "/audio/theme.mp3";
    lobbyMusic.addEventListener("error", () => {
      if (!musicRequested) return;
      pauseLobbyMusic();
      if (state?.phase === "lobby")
        error("The theme couldn’t play. Please try again.");
    });
  }
  if (lobbyMusic.error) lobbyMusic.load();
  const attempt = ++musicAttempt;
  musicRequested = true;
  updateMusicButton();
  lobbyMusic.play().catch(() => {
    if (attempt !== musicAttempt) return;
    pauseLobbyMusic();
    if (state?.phase === "lobby")
      error("The theme couldn’t play. Please try again.");
  });
}

function error(message) {
  $("#error").textContent = message;
  $("#error").hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    $("#error").hidden = true;
  }, 7000);
}
function send(event, data = {}) {
  return new Promise((resolve) =>
    socket.timeout(12000).emit(event, data, (err, result) => {
      if (err || !result?.ok) {
        error(err ? "Connection interrupted. Please try again." : result.error);
        resolve(false);
      } else resolve(true);
    }),
  );
}
function persist(code) {
  stored = { token, code, name: savedName };
  try {
    localStorage.setItem("slop-session", JSON.stringify(stored));
  } catch {
    /* Private browsing may disable storage. */
  }
  history.replaceState(null, "", `?room=${encodeURIComponent(code)}`);
}
function avatar(p, large = false) {
  return p.image
    ? `<img class="avatar ${large ? "large" : ""}" src="${esc(p.image)}" alt="${esc(p.name)}'s profile">`
    : `<span class="avatar ${large ? "large" : ""}" aria-hidden="true">${esc([...p.name][0]?.toUpperCase() || "?")}</span>`;
}
const player = (id) => state.players.find((p) => p.id === id);
const isHost = () => state.self === state.host;
const hostAction = (label, event, primary = true) =>
  isHost()
    ? `<button class="${primary ? "primary" : ""}" data-action="${event}">${label}</button>`
    : '<p class="small muted">Waiting for the host…</p>';
function bar() {
  return `<div class="room-bar"><span>ROOM <strong class="room-code">${esc(state.code)}</strong></span><button id="copy-link">Copy invite link</button><span>${state.round ? `ROUND ${String(state.round).padStart(2, "0")}` : "THE LOBBY"}</span></div>`;
}
function grid(selection = false) {
  return `<div class="player-grid">${state.players.map((p) => `<div class="player-card ${!p.connected ? "offline" : ""}" data-player="${p.id}">${avatar(p)}<span class="name">${esc(p.name)}${p.id === state.self ? " (you)" : ""}</span><span class="tag">${selection ? "&nbsp;" : !p.connected ? "Reconnecting" : p.id === state.host ? "Host" : "Ready"}</span></div>`).join("")}</div>`;
}
function joinScreen() {
  app.innerHTML = `<section class="fade-in"><p class="eyebrow">THE IMITATION PARTY GAME</p><h1><span>SLOP</span><span class="or">or</span><span>HUMAN</span></h1><p class="intro">One response is AI. The rest are your friends.<br><em>Can you tell the difference?</em></p><form id="join-form" class="join-card"><div class="tabs" role="group" aria-label="Room options"><button type="button" data-mode="create" class="${mode === "create" ? "selected" : ""}" aria-pressed="${mode === "create"}">Create a room</button><button type="button" data-mode="join" class="${mode === "join" ? "selected" : ""}" aria-pressed="${mode === "join"}">Join a room</button></div><div class="field"><label for="name">What should we call you?</label><input id="name" name="name" placeholder="Your suspiciously human name" maxlength="24" autocomplete="nickname" required value="${esc(savedName)}"></div><div class="profile-upload"><span id="profile-preview">${avatar({ name: savedName || "?", image: profileImage }, true)}</span><div><label class="upload-label" for="photo">Add a profile photo<input type="file" id="photo" accept="image/jpeg,image/png,image/webp"></label><p>Optional. A face to put to the fiction.</p></div></div>${mode === "join" ? `<div class="field"><label for="code">Room code</label><input id="code" name="code" placeholder="ABCDEF" maxlength="6" autocapitalize="characters" autocomplete="off" required value="${esc(new URLSearchParams(location.search).get("room") || "")}"></div>` : ""}<button id="join-button" class="primary full" type="submit">${mode === "create" ? "Make room for deception" : "Join the deception"} <span aria-hidden="true">→</span></button><p class="fine">3–24 players · One device each · No downloads</p></form><div class="steps"><div><span>01</span> Write the slop.</div><div><span>02</span> Spot the bot.</div><div><span>03</span> Fool your friends.</div></div></section>`;
  document.querySelectorAll("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        savedName = $("#name").value;
        mode = b.dataset.mode;
        joinScreen();
      }),
  );
  $("#photo").onchange = async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024
    )
      return error("Choose a JPEG, PNG, or WebP image under 5 MB.");
    try {
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, 128, 128);
      const side = Math.min(bitmap.width, bitmap.height);
      ctx.drawImage(
        bitmap,
        (bitmap.width - side) / 2,
        (bitmap.height - side) / 2,
        side,
        side,
        0,
        0,
        128,
        128,
      );
      bitmap.close();
      profileImage = canvas.toDataURL("image/webp", 0.8);
      $("#profile-preview").innerHTML = avatar(
        { name: $("#name").value || "?", image: profileImage },
        true,
      );
    } catch {
      error("This image could not be read. Choose another image.");
    }
  };
  $("#join-form").onsubmit = async (event) => {
    event.preventDefault();
    savedName = $("#name").value.trim();
    const button = $("#join-button");
    button.disabled = true;
    button.textContent = "Joining…";
    const ok = await send("join", {
      name: savedName,
      image: profileImage,
      token,
      create: mode === "create",
      code: $("#code")?.value,
    });
    if (!ok && !state) {
      button.disabled = false;
      button.textContent = "Try again →";
    }
  };
}
function leaderboard() {
  return `<ol class="leaderboard">${[...state.players]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => {
      const result = state.results?.find((r) => r.id === p.id);
      return `<li><span class="rank">${String(i + 1).padStart(2, "0")}</span>${avatar(p)}<span class="leader-name">${esc(p.name)}${p.id === state.self ? " (you)" : ""}${result ? `<span class="delta">+${result.points} this round</span>` : ""}</span><span class="points">${p.score} <small>pts</small></span></li>`;
    })
    .join("")}</ol>`;
}
function compose(kind) {
  const scenario = kind === "scenario";
  return `<form id="compose" class="compose"><label for="response">${scenario ? "Your scenario" : "Your response"}</label><textarea id="response" name="response" placeholder="${scenario ? "Set the scene. Make it weird." : "In today’s fast-paced world…"}" required>${esc(scenario ? scenarioDraft : localDraft)}</textarea><div class="counter-row"><span>${scenario ? "A situation, not a response." : "Your inner chatbot is showing."}</span><span id="counter">0 / 180</span></div><button class="primary full" id="submit-text">${scenario ? "Set the scenario" : "Lock in response"} →</button></form>`;
}
function gameScreen() {
  const renderKey = `${state.round}:${state.phase}`;
  const animatePoints =
    state.phase === "reveal" && lastRenderedKey !== renderKey;
  lastRenderedKey = renderKey;
  const old = $("#response");
  const focus = document.activeElement === old && old;
  const cursor = focus ? [old.selectionStart, old.selectionEnd] : null;
  const detailsOpen = $(".examples")?.open ?? true;
  clearTimeout(selectorTimer);
  let html = bar();
  if (state.phase === "lobby") {
    const online = state.players.filter((p) => p.connected).length;
    html += `<p class="eyebrow">GOOD COMPANY. QUESTIONABLE WRITING.</p><h2>The humans are<br>assembling.</h2><p class="small">Do not use bots in this game. That means you Logan.</p>${grid()}<p class="count-caption">${online} ${online === 1 ? "player" : "players"} connected · ${online < 3 ? `${3 - online} more needed to start` : "Everyone’s in? Let’s play."}</p><div class="lobby-actions">${isHost() ? `<button class="primary full" data-action="start" ${online < 3 || state.aiConfigured === false ? "disabled" : ""}>Start the game →</button>` : '<p class="small muted">Your host will start the game.</p>'}</div><p class="small note">One of you will write a scenario. Then everyone will try to sound like AI.<br>All you have to do is find the actual bot.</p>${state.aiConfigured === false ? '<p class="small note" role="status">AI responses aren’t connected yet. The host needs to enable AI before the game can start.</p>' : ""}`;
  } else if (state.phase === "selecting") {
    html += `<p class="eyebrow">ROUND ${state.round} · THE SELECTION</p><h2>Who sets<br>the scene?</h2>${grid(true)}<p id="selection-caption" class="small">A little random responsibility.</p>`;
  } else if (state.phase === "scenario") {
    const writer = player(state.writer);
    html += `<p class="eyebrow">ROUND ${state.round} · THE SCENARIO</p><div class="timer" data-timer></div><h2>${state.writer === state.self ? "Set the scene." : `${esc(writer.name)} is<br>writing the scenario.`}</h2><p class="small">${state.writer === state.self ? "Give your friends something worth overthinking." : "A performance review? A love letter? An entirely unnecessary apology?"}</p>`;
    if (state.writer === state.self)
      html += `${compose("scenario")}<details class="examples" ${detailsOpen ? "open" : ""}><summary>Need a little inspiration?</summary><div class="examples-list">${EXAMPLES.map((t, i) => `<button data-example="${i}">${esc(t)}</button>`).join("")}</div></details>`;
    else
      html += `<div class="waiting">${avatar(writer, true)}<p>Sharpen your artificial intelligence.<br>Your 60 seconds are coming.</p></div>`;
  } else if (state.phase === "writing") {
    html += `<p class="eyebrow">ROUND ${state.round} · THE IMITATION</p><div class="timer" data-timer></div><p class="scenario">${esc(state.scenario)}</p>`;
    if (state.closing)
      html +=
        '<div class="waiting"><h3>The submissions are in.</h3><p>Preparing the ballot…</p></div>';
    else if (state.hasSubmitted)
      html +=
        '<div class="waiting"><p class="eyebrow">RESPONSE LOCKED</p><h3>Suspiciously well put.</h3><p>Waiting for the other humans.</p></div>';
    else
      html += `<p class="small">Write something so convincingly AI-generated<br>that everyone thinks you’re the bot.</p>${compose("response")}`;
    html += `<p class="count-caption">${state.submitted} / ${state.expected} responses locked in</p>`;
  } else if (state.phase === "ai-error") {
    html += `<p class="eyebrow">ROUND ${state.round} · WAITING FOR AI</p><h2>${state.aiPending ? "Trying the AI again…" : "The bot missed its cue."}</h2><p class="scenario">${esc(state.scenario)}</p><p class="small" role="status">${state.aiPending ? "Generating a real response. Your answers are saved." : "The AI couldn’t generate a response. Your answers are saved, and this round will continue when it responds."}</p><div class="actions">${isHost() ? `<button class="primary" data-action="retry-ai" ${state.aiPending ? "disabled" : ""}>${state.aiPending ? "Generating…" : "Try the AI again →"}</button>` : '<p class="small muted">Waiting for the host to retry.</p>'}</div>`;
  } else if (state.phase === "voting") {
    html += `<p class="eyebrow">ROUND ${state.round} · THE DETECTION</p><div class="timer" data-timer></div><p class="scenario">${esc(state.scenario)}</p><h3>Which one is the bot?</h3><p class="small">One is artificial. The others are trying very hard.</p><div class="ballots">${state.ballot.map((r, i) => `<button class="ballot ${selected === r.id || state.votedFor === r.id ? "selected" : ""}" data-response="${r.id}" aria-pressed="${selected === r.id || state.votedFor === r.id}" ${state.hasVoted || r.isOwn ? "disabled" : ""}><span class="letter">${String.fromCharCode(65 + i)}</span><span class="ballot-text">${esc(r.text)}${r.isOwn ? '<span class="ballot-meta">Your response · you cannot vote for this</span>' : ""}</span></button>`).join("")}</div><button class="primary" id="confirm-vote" ${!selected || state.hasVoted ? "disabled" : ""}>${state.hasVoted ? "Vote locked in" : "Confirm my suspicion →"}</button><p class="count-caption">${state.voteCount} / ${state.voterCount} votes locked in</p>`;
  } else if (state.phase === "reveal") {
    const result = state.results.find((r) => r.id === state.self);
    html += `<p class="eyebrow">ROUND ${state.round} · THE REVEAL</p><h2>${result?.correct ? "You spotted the slop." : state.hasVoted ? "Convincing, wasn’t it?" : "The truth comes out."}</h2><p class="scenario">${esc(state.scenario)}</p><p class="small">Every response, with the masks off.</p><div class="ballots reveal-list">${state.ballot
      .map((r, i) => {
        const stats = state.results.find((p) => p.id === r.author);
        return `<div class="ballot ${r.author === null ? "ai" : ""}"><span class="letter">${String.fromCharCode(65 + i)}</span><div class="ballot-text">${r.author === null ? `<span class="ballot-label">THE ACTUAL AI</span><br>` : ""}${esc(r.text)}<span class="ballot-meta">${r.author === null ? esc(r.model ? `Generated by OpenAI · ${r.model}` : "AI generated") : esc(player(r.author)?.name)}${stats ? ` · Fooled ${stats.fooled} of ${stats.shown} voters` : ""}${r.voted ? " · Your vote" : ""}</span></div></div>`;
      })
      .join(
        "",
      )}</div><div class="stats"><div><strong>+${result?.detectionPoints || 0}</strong><span>Detector points</span></div><div><strong>+${result?.deception || 0}</strong><span>Deception points</span></div><div><strong>+${result?.points || 0}</strong><span>This round</span></div></div><details class="examples"><summary>Every response this round</summary><div class="examples-list">${state.responses.map((r) => `<p class="small"><strong>${r.author === null ? "AI" : esc(player(r.author)?.name)}:</strong> ${esc(r.text)}</p>`).join("")}</div></details><div class="actions">${hostAction("See the standings →", "leaderboard")}</div>`;
  } else if (state.phase === "leaderboard") {
    html += `<p class="eyebrow">ROUND ${state.round} · THE STANDINGS</p><h2>Artificial talent.<br>Real points.</h2>${leaderboard()}<div class="actions">${hostAction("Another round →", "next")}${isHost() ? '<button data-action="end">End the game</button>' : ""}</div>`;
  } else if (state.phase === "final") {
    const best = Math.max(...state.players.map((p) => p.score));
    const winners = state.players.filter((p) => p.score === best);
    html += `<p class="eyebrow">SLOP OR HUMAN · FINAL RESULTS</p><h2>${winners.length > 1 ? "Equally artificial." : "Almost too human."}</h2><div class="winner">${winners.length === 1 ? avatar(winners[0], true) : ""}<span class="winner-name">${esc(winners.map((p) => p.name).join(" & "))}</span></div><p class="small">${winners.length > 1 ? "Share the crown" : "Takes the crown"} with ${best} points.</p>${leaderboard()}<div class="awards">${state.awards.map((a) => `<div class="award"><p class="eyebrow">${esc(a.title)}</p><p>${a.winners.length ? esc(a.winners.map((id) => player(id).name).join(" & ")) : "No contenders. Yet."}</p></div>`).join("")}</div><div class="actions">${hostAction("Play again →", "again")}</div>`;
  }
  app.innerHTML = html;
  if (state.phase === "lobby") {
    const control = document.createElement("div");
    control.className = "lobby-music";
    const button = document.createElement("button");
    button.id = "lobby-music";
    button.type = "button";
    button.onclick = toggleLobbyMusic;
    control.append(button);
    $(".lobby-actions").after(control);
    updateMusicButton();
  }
  document.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = async () => {
        b.disabled = true;
        if (!(await send(b.dataset.action))) b.disabled = false;
      }),
  );
  $("#copy-link").onclick = async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $("#copy-link").textContent = "Link copied";
    } catch {
      error(`Invite friends with room code ${state.code}.`);
    }
  };
  if ($("#response")) {
    const input = $("#response");
    const update = () => {
      const n = [...input.value].length;
      $("#counter").textContent = `${n} / 180`;
      $("#submit-text").disabled = !input.value.trim() || n > 180;
    };
    input.oninput = () => {
      if (state.phase === "scenario") scenarioDraft = input.value;
      else {
        localDraft = input.value;
        clearTimeout(draftTimer);
        draftTimer = setTimeout(() => send("draft", { text: localDraft }), 150);
      }
      update();
    };
    update();
    $("#compose").onsubmit = async (e) => {
      e.preventDefault();
      clearTimeout(draftTimer);
      const button = $("#submit-text");
      button.disabled = true;
      if (
        !(await send(state.phase === "scenario" ? "scenario" : "submit", {
          text: input.value,
        }))
      )
        button.disabled = false;
    };
    document.querySelectorAll("[data-example]").forEach(
      (b) =>
        (b.onclick = () => {
          input.value = EXAMPLES[Number(b.dataset.example)];
          input.dispatchEvent(new Event("input"));
          input.focus();
        }),
    );
    if (focus) {
      input.focus();
      input.setSelectionRange(...cursor);
    }
  }
  document.querySelectorAll("[data-response]").forEach(
    (b) =>
      (b.onclick = () => {
        selected = b.dataset.response;
        gameScreen();
      }),
  );
  if ($("#confirm-vote"))
    $("#confirm-vote").onclick = async () => {
      const b = $("#confirm-vote");
      b.disabled = true;
      if (!(await send("vote", { id: selected }))) b.disabled = false;
    };
  if (state.phase === "selecting") runSelection();
  updateTimer();
  if (
    animatePoints &&
    !matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    document.querySelectorAll(".stats strong").forEach((el) => {
      const total = Number(el.textContent.replace("+", ""));
      const start = performance.now();
      const tick = (now) => {
        if (!el.isConnected) return;
        const progress = Math.min(1, (now - start) / 450);
        el.textContent = `+${Math.round(total * progress)}`;
        if (progress < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }
}
function runSelection() {
  const cards = [...document.querySelectorAll("[data-player]")];
  const remaining = Math.max(0, state.deadline - (Date.now() + clockOffset));
  const chosen = cards.find((c) => c.dataset.player === state.writer);
  const start = Date.now();
  let i = 0;
  const tick = () => {
    cards.forEach((c) => c.classList.remove("active"));
    const progress = Math.min(
      1,
      (Date.now() - start) / Math.max(1, remaining - 250),
    );
    if (progress >= 1) {
      chosen?.classList.add("active");
      $("#selection-caption").textContent =
        `${player(state.writer).name} is writing the scenario.`;
      return;
    }
    cards[i++ % cards.length]?.classList.add("active");
    selectorTimer = setTimeout(tick, 55 + 230 * progress * progress);
  };
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    chosen?.classList.add("active");
    return;
  }
  tick();
}
function updateTimer() {
  const el = $("[data-timer]");
  if (!el) return;
  const seconds = state.deadline
    ? Math.max(0, Math.ceil((state.deadline - Date.now() - clockOffset) / 1000))
    : 0;
  el.textContent = state.closing ? "—" : `${seconds}s`;
  el.setAttribute("aria-label", `${seconds} seconds remaining`);
}
setInterval(updateTimer, 250);
socket.on("connect", async () => {
  $("#connection").textContent = "Connected";
  const roomCode = new URLSearchParams(location.search).get("room");
  if (stored?.code && roomCode?.toUpperCase() === stored.code && !rejoining) {
    rejoining = true;
    const ok = await send("join", {
      code: stored.code,
      token,
      name: stored.name,
    });
    rejoining = false;
    if (!ok) {
      state = null;
      joinScreen();
    }
  }
});
socket.on("disconnect", (reason) => {
  pauseLobbyMusic();
  $("#connection").textContent =
    reason === "io server disconnect" ? "Disconnected" : "Reconnecting…";
});
socket.on("replaced", () => {
  error(
    "This player session was opened in another tab. Continue playing there.",
  );
});
socket.on("state", (next) => {
  if (next.phase !== "lobby") pauseLobbyMusic();
  clockOffset = next.serverNow - Date.now();
  if (lastRound !== next.round) {
    localDraft = "";
    scenarioDraft = "";
    selected = null;
    lastRound = next.round;
  }
  if (state?.phase !== next.phase) selected = null;
  if (!localDraft && next.draft) localDraft = next.draft;
  state = next;
  persist(next.code);
  gameScreen();
});
$("#rules-open").onclick = () => $("#rules").showModal();
$("#rules-close").onclick = () => $("#rules").close();
$("#rules").onclick = (e) => {
  if (e.target === $("#rules")) $("#rules").close();
};
joinScreen();
