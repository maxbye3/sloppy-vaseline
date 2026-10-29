# Slop or Human

A browser party game for 3–24 players. Write something that sounds like AI, then find the actual bot among your friends. Black and white, Times New Roman, and no accounts.

## Run

Requires Node.js 22 or newer (validated on Node 24).

```sh
npm ci
npm start
```

The server listens on port 3000 on all interfaces. Open the app in a browser, create a room, and share its invite link or six-character code. Each player uses their own browser/device. `npm run dev` restarts the server when source files change; restarting clears active games.

For cloud machines with a read-only home directory, use `npm ci --cache /workspace/.npm-cache`.

## AI responses

Set `SLOP_AI_API_KEY` in the server environment for genuine AI responses from OpenAI. `OPENAI_API_KEY` is also accepted. Never put the key in browser code. For local development, copy `.env.example` to `.env` and fill in the key. `OPENAI_MODEL` optionally selects the model (default `gpt-4o-mini`). `PORT` changes the listening port.

A working API key is required to start a game. Each prompt gets one AI response generated for its scenario using the AI SDK and OpenAI; there are no canned substitutes. The model answers directly in the requested voice, using relevant, coherent, deadpan humour: a believable statement with a specific absurd detail, petty bureaucratic rule, or dry punchline. Style examples guide the tone, but each round requests fresh wording and a new joke instead of repeating the scenario or copying an example. Responses must be complete and fit the same hard 180-character limit as human submissions, without padding to fill it. If the first response is empty, unfinished, or too long, the model gets one rewrite request that preserves the scenario, voice, and joke; text is never cut off to make it fit.

The AI response is generated while the humans write. There is one successful generation per prompt, plus any necessary retries or rewrites. Transient provider failures get one retry, with a 20-second total deadline including any length correction. If generation still fails, the round pauses before voting. Human answers stay saved, no points are awarded, and only the host can retry generation for the same scenario. The reveal identifies the actual model; provider metadata stays hidden before voting ends. Human drafts and responses are never sent to the AI provider.

Add `SLOP_AI_API_KEY` securely in your Render service's **Environment** settings, then save and redeploy. `OPENAI_API_KEY` also works. The key needs access to the selected model and available API credits. Never put it in browser code, Git, or chat. A key configured in an agent's environment does not automatically configure the Render service.

The server logs a safe failure category (`authentication`, `rate_limit`, `timeout`, or `provider_unavailable`) without logging credentials, scenarios, or provider response bodies. A configured key is checked for presence before game start; validity and credits are checked by the provider during generation.

## Game rules and edge cases

- The host starts, advances, and ends the game. Each round rotates the writer without repetition until everyone eligible has had a turn.
- Everyone, including the scenario writer, submits a response and votes. AI text is hidden while writing, and its identity and model remain hidden from everyone until the reveal.
- Selection lasts 3 seconds. The writer has 60 seconds to choose a scenario, then a preset is chosen automatically if needed. Responses get 60 seconds, and voting gets a visible 60-second countdown. Voting ends immediately when everyone has confirmed a vote. Authors and scores stay hidden until the reveal.
- Drafts synchronize to the server while typing and are submitted at expiry. Blank responses are omitted. Submitted responses and confirmed votes cannot change.
- Everyone writes once per prompt, including the scenario writer. Every valid human response and exactly one AI response appear together on a single ballot, shuffled independently for each player. There are no voting groups or extra voting stages. Missing submissions are omitted. Your own response is visible but disabled, and the server rejects self-votes.
- Correctly detecting the AI earns 10 points. Deception earns `round(15 × votes received / eligible ballots shown)`, or zero with no exposure. Exposure excludes the author, who cannot vote for themselves. Scores update once after voting ends.
- Profiles and scores survive browser refresh/reconnect. One browser session controls a player; opening its session in another tab transfers control. Host privileges transfer after 15 seconds offline. Late entrants wait until the game returns to the lobby.
- Photos accept JPEG, PNG, and WebP up to 5 MB. The browser compresses them; the server validates and resizes to 128px square monochrome WebP.
- Final awards use real votes, correct detections, and cumulative exposure; ties are shared and unearned awards show no contenders.

## Validate

```sh
npm test
```

Node's test runner checks full-room ballots for rooms of 3–24 players, equal exposure, self-vote rejection, scoring, authorization, deadlines, writer rotation, generation failures and retry recovery, host transfer, and a complete five-player game over real Socket.IO connections including reconnect and replay. `/health` returns `{"ok":true}`. There is no frontend build step.

## Deploy on Render

The included `render.yaml` runs the frontend and WebSocket server together as one Node web service. Render provides the public HTTPS address; no frontend URL or CORS changes are needed.

1. In [Render](https://dashboard.render.com/), choose **New → Blueprint**, connect `maxbye3/sloppy-vaseline`, and select `main`.
2. Review the `slop-or-human` service and deploy. The Blueprint uses a free instance for evaluation. For reliable game nights, select an always-on paid instance in Render: free instances can sleep after inactivity, and waking takes time.
3. Enter `SLOP_AI_API_KEY` securely when the Blueprint prompts for it, or add it in the service's **Environment** settings for an existing deployment. It is required for real AI responses. Saving it may restart the service.
4. After deployment succeeds, open the HTTPS address Render provides and create a room. Share the invite link from that public site, rather than a localhost URL.

The build installs locked dependencies, runs tests, then removes development dependencies. The service starts with `npm start`, listens on Render's supplied `PORT`, and reports readiness at `/health`. Keep a single instance because rooms live in process memory. Deployments and restarts end active games; deploy between sessions and consider disabling automatic deployments in the Render dashboard.

Actual deployment requires your Render account and connection to this GitHub repository. The Blueprint alone does not create a hosted service or incur a paid-plan charge.

## Hosting scope

Serve one Node process behind an HTTPS reverse proxy with WebSocket support. Use the public HTTPS origin in invite links so other devices can join. The included server has input validation, bounded image decoding, per-connection event limits, and room limits, but is intended for small private parties.

Rooms, sessions, avatars, and scores live in memory. Server restarts lose them; they are not retained across deployment. Empty rooms expire after two hours. Multiple instances, durable storage, global abuse protection, and production hosting are outside this initial implementation. No deployment is performed by `npm start`.
