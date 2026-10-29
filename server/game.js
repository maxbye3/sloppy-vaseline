import { randomInt, randomUUID } from "node:crypto";

export const EXAMPLES = [
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
export const length = (text) => [...text].length;
export function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function makeBallots(voters, responses) {
  const humans = responses.filter((r) => r.author !== null);
  const exposure = Object.fromEntries(
    humans.map((r) => [r.id, voters.filter((id) => id !== r.author).length]),
  );
  const ballots = Object.fromEntries(
    voters.map((id) => [id, shuffle(responses).map((r) => r.id)]),
  );
  return { ballots, exposure };
}

export class Room {
  constructor(code, generate, notify, durations = {}) {
    this.code = code;
    this.generate = generate;
    this.notify = notify;
    this.times = {
      selecting: 3000,
      scenario: 60000,
      writing: 60000,
      voting: 60000,
      hostGrace: 15000,
      ...durations,
    };
    this.players = new Map();
    this.phase = "lobby";
    this.round = 0;
    this.host = null;
    this.usedWriters = new Set();
    this.timers = new Set();
    this.touched = Date.now();
  }
  later(fn, delay) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, delay);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }
  destroy() {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
  change(phase, duration) {
    clearTimeout(this.phaseTimer);
    this.timers.delete(this.phaseTimer);
    this.phase = phase;
    this.deadline = duration ? Date.now() + duration : null;
    if (duration) this.phaseTimer = this.later(() => this.expire(), duration);
    this.emit();
  }
  emit() {
    this.touched = Date.now();
    this.notify(this);
  }
  connect(id, name, image) {
    let p = this.players.get(id);
    if (!p) {
      if (this.phase !== "lobby")
        throw new Error(
          "This game has started. Join when the host plays again.",
        );
      if (this.players.size >= 24)
        throw new Error("This room is full (24 players).");
      p = {
        id,
        name,
        image,
        score: 0,
        correct: 0,
        fooled: 0,
        shown: 0,
        connected: true,
      };
      this.players.set(id, p);
    }
    p.connected = true;
    if (!this.host || !this.players.get(this.host)?.connected) this.host = id;
    this.emit();
    return p;
  }
  disconnect(id) {
    const p = this.players.get(id);
    if (!p) return;
    p.connected = false;
    this.emit();
    this.later(() => {
      if (!p.connected && this.host === id) {
        this.host =
          [...this.players.values()].find((p) => p.connected)?.id || null;
        this.emit();
      }
    }, this.times.hostGrace);
  }
  requireHost(id) {
    if (id !== this.host) throw new Error("Only the host can do that.");
  }
  begin(id) {
    this.requireHost(id);
    if (!["lobby", "leaderboard"].includes(this.phase))
      throw new Error("Finish this round first.");
    const active = [...this.players.values()].filter((p) => p.connected);
    if (active.length < 3)
      throw new Error("At least three connected players are needed.");
    this.participants = active.map((p) => p.id);
    let choices = active.filter((p) => !this.usedWriters.has(p.id));
    if (!choices.length) {
      this.usedWriters.clear();
      choices = active;
    }
    this.writer = shuffle(choices)[0].id;
    this.usedWriters.add(this.writer);
    this.round++;
    this.scenario = "";
    this.responses = [];
    this.drafts = {};
    this.submitted = new Set();
    this.votes = {};
    this.ballots = {};
    this.exposure = {};
    this.results = [];
    this.aiReady = false;
    this.aiPending = false;
    this.aiError = false;
    this.closing = false;
    this.change("selecting", this.times.selecting);
  }
  expire() {
    if (this.phase === "selecting")
      this.change("scenario", this.times.scenario);
    else if (this.phase === "scenario")
      this.setScenario(this.writer, shuffle(EXAMPLES)[0]);
    else if (this.phase === "writing") this.closeWriting();
    else if (this.phase === "voting") this.reveal();
  }
  setScenario(id, text) {
    if (this.phase !== "scenario" || id !== this.writer)
      throw new Error("Only the scenario writer can submit now.");
    text = validateText(text);
    this.scenario = text;
    this.change("writing", this.times.writing);
    this.requestAi();
  }
  requestAi() {
    if (this.aiPending || this.aiReady) return;
    const round = this.round;
    this.aiPending = true;
    this.aiError = false;
    // Neither drafts nor human submissions are ever passed to the AI provider.
    Promise.resolve()
      .then(() => this.generate(this.scenario))
      .then((ai) => {
        if (
          this.round !== round ||
          !["writing", "ai-error"].includes(this.phase)
        )
          return;
        if (
          ai?.fallback ||
          typeof ai?.text !== "string" ||
          !ai.text.trim() ||
          length(ai.text.trim()) > 180
        )
          throw new Error("AI generation did not return a valid response.");
        this.responses.push({
          id: randomUUID(),
          author: null,
          text: ai.text.trim(),
          model: ai.model,
          responseId: ai.responseId,
        });
        this.aiPending = false;
        this.aiReady = true;
        if (this.closing) this.openVoting();
      })
      .catch(() => {
        if (
          this.round !== round ||
          !["writing", "ai-error"].includes(this.phase)
        )
          return;
        this.aiPending = false;
        this.aiError = true;
        if (this.closing) this.change("ai-error");
      });
  }
  retryAi(id) {
    this.requireHost(id);
    if (this.phase !== "ai-error" || this.aiPending)
      throw new Error("AI generation cannot be retried now.");
    this.requestAi();
    this.emit();
  }
  eligible(id) {
    return this.participants.includes(id);
  }
  draft(id, text) {
    if (
      this.phase !== "writing" ||
      this.closing ||
      !this.eligible(id) ||
      this.submitted.has(id)
    )
      return;
    this.drafts[id] =
      typeof text === "string" ? [...text].slice(0, 180).join("") : "";
  }
  submit(id, text) {
    if (this.phase !== "writing" || this.closing || !this.eligible(id))
      throw new Error("You cannot submit a response now.");
    if (this.submitted.has(id))
      throw new Error("Your response is already locked.");
    text = validateText(text);
    this.responses.push({ id: randomUUID(), author: id, text });
    this.submitted.add(id);
    if (this.participants.every((p) => this.submitted.has(p)))
      this.closeWriting();
    else this.emit();
  }
  closeWriting() {
    if (this.closing || this.phase !== "writing") return;
    this.closing = true;
    clearTimeout(this.phaseTimer);
    this.timers.delete(this.phaseTimer);
    this.deadline = null;
    for (const id of this.participants) {
      const text = this.drafts[id]?.trim();
      if (this.eligible(id) && !this.submitted.has(id) && text) {
        this.responses.push({ id: randomUUID(), author: id, text });
        this.submitted.add(id);
      }
    }
    if (this.aiReady) this.openVoting();
    else if (this.aiError) this.change("ai-error");
    else this.emit();
  }
  openVoting() {
    this.closing = false;
    const distribution = makeBallots(this.participants, this.responses);
    this.ballots = distribution.ballots;
    Object.assign(this.exposure, distribution.exposure);
    this.change("voting", this.times.voting);
  }
  vote(id, responseId) {
    if (this.phase !== "voting" || !this.ballots[id]?.includes(responseId))
      throw new Error("Choose a response from your ballot.");
    if (this.responses.find((r) => r.id === responseId)?.author === id)
      throw new Error("You cannot vote for your own response.");
    if (this.votes[id]) throw new Error("Your vote is already locked.");
    this.votes[id] = responseId;
    if (this.participants.every((p) => this.votes[p])) this.reveal();
    else this.emit();
  }
  reveal() {
    if (this.phase !== "voting") return;
    const ai = this.responses.find((r) => r.author === null);
    this.results = this.participants.map((id) => {
      const p = this.players.get(id);
      const response = this.responses.find((r) => r.author === id);
      const fooled = response
        ? Object.values(this.votes).filter((v) => v === response.id).length
        : 0;
      const shown = response ? this.exposure[response.id] || 0 : 0;
      const correct = Number(this.votes[id] === ai.id);
      const detectionPoints = correct * 10;
      const deception = shown ? Math.round((15 * fooled) / shown) : 0;
      const points = detectionPoints + deception;
      p.score += points;
      p.correct += Number(correct);
      p.fooled += fooled;
      p.shown += shown;
      return { id, fooled, shown, correct, detectionPoints, deception, points };
    });
    this.change("reveal");
  }
  advance(id) {
    this.requireHost(id);
    if (this.phase !== "reveal") throw new Error("Wait for the reveal.");
    this.change("leaderboard");
  }
  end(id) {
    this.requireHost(id);
    if (this.phase !== "leaderboard")
      throw new Error("Finish the round first.");
    this.change("final");
  }
  again(id) {
    this.requireHost(id);
    if (this.phase !== "final") throw new Error("Finish the game first.");
    for (const p of this.players.values())
      Object.assign(p, { score: 0, correct: 0, fooled: 0, shown: 0 });
    this.round = 0;
    this.usedWriters.clear();
    this.participants = [];
    this.writer = null;
    this.scenario = "";
    this.results = [];
    this.responses = [];
    this.ballots = {};
    this.votes = {};
    this.change("lobby");
  }
  state(id) {
    const revealed = ["reveal", "leaderboard", "final"].includes(this.phase);
    const players = [...this.players.values()].map(
      ({ id, name, image, score, connected }) => ({
        id,
        name,
        image,
        score,
        connected,
      }),
    );
    const state = {
      code: this.code,
      phase: this.phase,
      round: this.round,
      host: this.host,
      players,
      self: id,
      writer: this.writer,
      scenario: this.scenario,
      deadline: this.deadline,
      serverNow: Date.now(),
      submitted: this.submitted?.size || 0,
      expected: this.participants?.length || 0,
      hasSubmitted: this.submitted?.has(id) || false,
      draft: this.drafts?.[id] || "",
      voteCount: Object.keys(this.votes || {}).length,
      voterCount: this.participants?.length || 0,
      hasVoted: Boolean(this.votes?.[id]),
      votedFor: this.votes?.[id] || null,
      participating: this.participants?.includes(id) || false,
      closing: this.closing || false,
      ...(this.phase === "ai-error" ? { aiPending: this.aiPending } : {}),
      ballot: (this.ballots?.[id] || []).map((rid) => {
        const r = this.responses.find((r) => r.id === rid);
        return {
          id: r.id,
          text: r.text,
          isOwn: r.author === id,
          ...(revealed ? { voted: this.votes[id] === rid } : {}),
          ...(revealed ? { author: r.author, model: r.model } : {}),
        };
      }),
    };
    if (revealed)
      Object.assign(state, {
        responses: this.responses,
        results: this.results,
      });
    if (this.phase === "final") {
      const all = [...this.players.values()];
      const award = (metric, valid) => {
        const eligible = all.filter(valid);
        if (!eligible.length) return [];
        const max = Math.max(...eligible.map(metric));
        return eligible.filter((p) => metric(p) === max).map((p) => p.id);
      };
      state.awards = [
        {
          title: "Most Artificial Human",
          winners: award(
            (p) => p.fooled,
            (p) => p.fooled > 0,
          ),
        },
        {
          title: "Human AI Detector",
          winners: award(
            (p) => p.correct,
            (p) => p.correct > 0,
          ),
        },
        {
          title: "Certified Slop Merchant",
          winners: award(
            (p) => p.fooled / p.shown,
            (p) => p.shown > 0 && p.fooled > 0,
          ),
        },
      ];
    }
    return state;
  }
}

function validateText(text) {
  if (typeof text !== "string" || !text.trim() || length(text.trim()) > 180)
    throw new Error("Enter between 1 and 180 characters.");
  return text.trim();
}
