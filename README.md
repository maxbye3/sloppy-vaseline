# Slop or Human

A browser party game for 4–24 players. Write something that sounds like AI, then find the actual bot among your friends. Black and white, Times New Roman, and no accounts.

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

Without a key, or if the provider fails or exceeds an eight-second timeout, the server uses a scenario-specific preset fallback. It is explicitly disclosed at reveal. Fallback rounds are playable, but their competing entry is **not a newly generated AI response**. Human drafts and responses are never sent to the AI provider.

Cloud environment settings support an optional personal secret named `SLOP_AI_API_KEY`, restricted to `api.openai.com`. Enter its value securely in those settings, not in chat. Genuine provider generation needs that binding and network access; it has not been live-tested without credentials.

## Game rules and edge cases

- The host starts, advances, and ends the game. Each round rotates the writer without repetition until everyone eligible has had a turn.
- Selection lasts 3 seconds. The writer has 60 seconds to choose a scenario, then a preset is chosen automatically if needed. Responses get 60 seconds, and confirmed votes get 20 seconds.
- Drafts synchronize to the server while typing and are submitted at expiry. Blank responses are omitted. Submitted responses and confirmed votes cannot change.
- Ballots include the AI entry and up to three other human responses, balanced by exposure. A player never sees their own response. **Four choices require at least five players with all responses submitted.** With four players, or missing submissions, fewer choices are shown. No duplicates or fabricated human responses fill the gaps.
- Correct detection earns 10 points. Deception earns `round(15 × votes received / ballots shown)`, or zero with no exposure.
- Profiles and scores survive browser refresh/reconnect. One browser session controls a player; opening its session in another tab transfers control. Host privileges transfer after 15 seconds offline. Late entrants wait until the game returns to the lobby.
- Photos accept JPEG, PNG, and WebP up to 5 MB. The browser compresses them; the server validates and resizes to 128px square monochrome WebP.
- Final awards use real votes, correct detections, and cumulative exposure; ties are shared and unearned awards show no contenders.

## Validate

```sh
npm test
```

Node's test runner checks private ballots for rooms of 4–24 players, exposure balance, scoring, authorization, deadlines, writer rotation, fallback, host transfer, and a complete five-player game over real Socket.IO connections including reconnect and replay. `/health` returns `{"ok":true}`. There is no frontend build step.

## Deploy on Render

The included `render.yaml` runs the frontend and WebSocket server together as one Node web service. Render provides the public HTTPS address; no frontend URL or CORS changes are needed.

1. In [Render](https://dashboard.render.com/), choose **New → Blueprint**, connect `maxbye3/sloppy-vaseline`, and select `main`.
2. Review the `slop-or-human` service and deploy. The Blueprint uses a free instance for evaluation. For reliable game nights, select an always-on paid instance in Render: free instances can sleep after inactivity, and waking takes time.
3. For genuine AI responses, add `SLOP_AI_API_KEY` securely in the service's **Environment** settings. It is optional and intentionally absent from the Blueprint so fallback games can deploy without a key. Saving it may restart the service.
4. After deployment succeeds, open the HTTPS address Render provides and create a room. Share the invite link from that public site, rather than a localhost URL.

The build installs locked dependencies, runs tests, then removes development dependencies. The service starts with `npm start`, listens on Render's supplied `PORT`, and reports readiness at `/health`. Keep a single instance because rooms live in process memory. Deployments and restarts end active games; deploy between sessions and consider disabling automatic deployments in the Render dashboard.

Actual deployment requires your Render account and connection to this GitHub repository. The Blueprint alone does not create a hosted service or incur a paid-plan charge.

## Hosting scope

Serve one Node process behind an HTTPS reverse proxy with WebSocket support. Use the public HTTPS origin in invite links so other devices can join. The included server has input validation, bounded image decoding, per-connection event limits, and room limits, but is intended for small private parties.

Rooms, sessions, avatars, and scores live in memory. Server restarts lose them; they are not retained across deployment. Empty rooms expire after two hours. Multiple instances, durable storage, global abuse protection, and production hosting are outside this initial implementation. No deployment is performed by `npm start`.
