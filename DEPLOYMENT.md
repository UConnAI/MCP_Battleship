# Six-team competition: setup and event guide

This version accepts **strategy text**, not uploaded code. Every team uses the same fixed MCP referee tools and the same Groq model. It runs one six-team knockout tournament at a time, with at most two matches running concurrently.

## Try the complete flow locally without API charges

Install Node.js 22 or later, open a terminal in this repository, and run:

```sh
npm test
npm run demo
```

Open http://127.0.0.1:3000/tournament.html. Expand **Connection & organizer controls**, enter the demo-only organizer token `local-demo-organizer-token`, and unlock controls. Click **Fill demo teams**. Six scripted bots enter; after five seconds, two opening matches start. Winners proceed through two semifinals and a final. Demo bots do not interpret strategy text and do not call an LLM.

Use **Pause**, then wait for in-flight moves to settle, then **Archive & reset** to start a new demo. The previous state is archived; nothing is deleted. Codes rotate on every reset. Keep demo mode bound to localhost; it has a publicly documented organizer token.

## Enable the real model locally

1. Copy `.env.example` to `.env`.
2. Set `GROQ_API_KEY` to your own Groq API key.
3. Generate a random organizer secret, for example `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`, and set `ADMIN_TOKEN`. Keep it private.
4. Run `npm start` and open the same local page.
5. Unlock organizer controls using your secret. Distribute exactly one of the six generated team codes to each team.

No dependencies need installing. The model defaults to `openai/gpt-oss-120b`, low reasoning effort, with a 1,024 completion-token cap per request. The adapter is intended for the GPT-OSS models on Groq; arbitrary model IDs may not support its parameters. Requests share conservative pacing (at most 60 starts/minute and a character-based estimate targeting 120,000 tokens/minute); actual tokenization and account quotas can differ. A paid account and a real provider rehearsal are required before the event.

The runner connects the model's tool-call response to the trusted referee's JSON-RPC dispatcher **inside the backend process**. It injects the appropriate match/seat credentials itself. It does not launch OpenCode or execute team code. The original standalone HTTP MCP remains in `arena/` for independent experiments.

## Hosted backend: Render option

`render.yaml` prepares one Node service with a persistent disk. **It provisions a paid instance and disk if you choose to deploy it. No hosted service is created just by adding this file to GitHub.** Review the provider's displayed charges before creation.

1. Connect this repository to a Render Blueprint using the branch containing this implementation (or main after merge).
2. Supply `GROQ_API_KEY` in Render's secret environment settings. Render generates `ADMIN_TOKEN`; retrieve it privately from the service's environment settings for organizer access.
3. Deploy and verify `/api/health` returns `{"ok":true,"demo":false}`.
4. Open `https://YOUR-SERVICE.onrender.com/tournament.html` to rehearse. The backend also serves the frontend, so this URL works before Pages is configured.
5. Keep exactly **one backend instance**. State is an atomic JSON snapshot on the persistent disk. Multiple processes or replicas must not share this state directory. Do not enable autoscaling or deploy updates during a match. A restart pauses the event and requires an organizer resume.

Alternative: use the included Dockerfile on a host supporting an always-running container, HTTPS, and a writable persistent volume mounted at `/app/data`. Provide the same secrets and environment values. This is not a stateless/serverless handler.

## GitHub Pages frontend

1. In `dist/config.js`, set `apiBase` to the HTTPS backend origin, with no trailing slash:

   ```js
   window.BATTLESHIP_CONFIG = { apiBase: 'https://YOUR-SERVICE.onrender.com' };
   ```

2. Set the backend's `ALLOWED_ORIGINS` to `https://uconnai.github.io`. Use exact comma-separated origins if also serving a custom domain. Do not include repository paths.
3. In repository **Settings → Pages**, select **GitHub Actions** as the source.
4. Merge the implementation to main, then run or allow the **Publish GitHub Pages** workflow. Its tests must pass before deployment.
5. The tournament entry point will be `https://uconnai.github.io/MCP_Battleship/tournament.html`. The root page preserves the original manual game and links to the tournament.

The Connection panel can override the backend address for a rehearsal; the override is saved only in that browser. Organizer tokens are held in page memory and never written to browser storage. Never put keys, team codes, live state, or organizer tokens in config.js, the repository, or Pages artifacts.

## Event flow and rules

- Six unique invite codes map to six team slots. Teams may update their submission until all six are ready. Names must be unique; strategies are 10–6,000 characters.
- The sixth valid submission atomically locks the lobby and starts a 15-second countdown. `AUTO_START=false` lets the organizer start it manually instead.
- Randomly draw two byes. The other four teams play two simultaneous opening games. Each winner meets one bye recipient in the semifinals. The final follows when both semifinals finish. Five games total.
- Starting seats are randomized for each game. Fleets and agent context reset each match; each request receives the team's frozen strategy and current private view.
- Matches have a default five-minute **active decision-time** limit. Time is counted while awaiting successful model responses, including invalid-move retries; organizer pauses and failed provider requests do not count. At the limit, finish an equal number of shots and compare hits. Equal hits use a random tiebreak assigned before the match. This can exceed the nominal limit by a final turn. An ordinary fleet-destruction victory still ends immediately.
- Three invalid tool responses pause the event, as do API errors/timeouts. No silent model fallback or automatic provider-error forfeits. Fix the cause and resume. While paused, in-flight responses are discarded but reported token usage is counted.
- Browser reconnects receive the latest full public snapshot. Spectators see shots and results, never live fleets, private strategies, tokens, or tactical notes. Fleet positions reveal only after a game ends.
- `MAX_REQUESTS` (default 2,000) and `MAX_TOTAL_TOKENS` (default 2,000,000) stop further requests at the next check. The token threshold uses reported usage and may be exceeded by in-flight responses; it is not a hard dollar cap. Configure a provider-side spending limit too. Provider requests that fail are still counted; unavailable usage cannot be counted locally.
- A reset requires organizer authentication, a paused/finished/lobby state, the current event ID, and no in-flight players. It archives all private state and rotates team codes. Protect backups and the data disk.

## Rehearsal checklist

1. Submit six test strategies using six codes; verify duplicate submissions update one slot.
2. Confirm two games advance simultaneously and the bracket reaches one winner.
3. Run from the actual Pages URL to verify HTTPS, CORS and live events.
4. Pause/resume once; restart the backend and verify it loads paused without losing shots.
5. Measure full tournament duration, API errors and actual usage with the live model. Nominal timing is not a latency guarantee.
6. Archive/reset, distribute new codes, and keep the organizer controls private during the event.

## Verification performed during implementation

Automated tests cover bracket formation, duplicate/invalid submissions, turn rules, hidden information, equal-turn adjudication, restart recovery, parallel tournament completion, provider failures, budgets, late responses after pause, Groq request formatting and API handlers. API tests dispatch requests in-process; they do not prove external network routing, TLS, hosting, or provider connectivity. A local socket check was blocked by the execution environment, and the browser preview surface was unavailable. No paid model calls or cloud deployments were performed.
