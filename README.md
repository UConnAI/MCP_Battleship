# MCP Battleship

## Six-team live tournament

The new competition entry point is **`dist/tournament.html`**. It accepts private team strategy text, locks after six submissions, draws two random byes, runs two opening matches in parallel, and advances winners through semifinals and a final. Spectators receive live shot updates; fleets reveal only after each match. Organizer controls include invite codes, pause/resume, usage counters, and archive/reset.

The Node.js 22+ backend is in `server/`. It uses the existing referee engine and a shared Groq model; team code uploads and OpenCode execution are not enabled. No API keys are sent to the frontend.

```sh
npm test
npm run demo
```

Open **http://127.0.0.1:3000/tournament.html**. Demo mode uses scripted bots and no API calls. For real AI play, hosting, GitHub Pages and event setup, see **[DEPLOYMENT.md](DEPLOYMENT.md)**. A Dockerfile, optional Render Blueprint, and GitHub Pages workflow are included. Hosting and live model credentials still need configuring.

## Original prototype and standalone MCP

A monochrome Battleship game and a local arena where agents compete using different strategy prompts through an MCP referee.

## Play and explore

- [Play Battleship](https://battleship-grey-g7n4q.unknownrico.chatgpt.site/)
- [Agent arena and recorded match](https://battleship-grey-g7n4q.unknownrico.chatgpt.site/arena.html)

The deployed demo may require its owner's sign-in. The source can be served independently.

The manual game supports placing and rotating three ships: big (5 squares), medium (3), and small (2). The arena includes a shared base prompt, editable strategy drafts, JSON export, and a shot-by-shot replay with tactical notes.

## Run locally

The frontend is buildless HTML, CSS, and JavaScript. Serve `dist/` with a static HTTP server, then visit `/` for the manual game or `/arena.html` for the agent arena. For example, with Python installed:

```sh
python -m http.server 8080 --directory dist
```

The MCP runtime requires Node.js 20 or newer and has no package dependencies. Export the two strategy prompts from the arena, save the JSON in the repository root, and run:

```sh
node arena/setup.mjs match-prompts.json
node arena/referee.mjs serve .arena-state
```

Give each agent the base prompt, its strategy, its match ID, and only its own seat token. The local MCP endpoint is `http://127.0.0.1:8771/mcp`.

See [the runtime guide](arena/README.md) for tool calls, prompt composition, and replay export.

## Project layout

| Path | Purpose |
| --- | --- |
| `dist/` | Playable web frontend and completed exhibition replay |
| `arena/referee.mjs` | MCP server, rules, turn enforcement, and private player views |
| `arena/client.mjs` | Thin client for MCP tool calls |
| `arena/base-prompt.txt` | Shared agent instructions |
| `arena/setup.mjs` | Create a match and separate seat tokens |
| `arena/export-replay.mjs` | Export completed matches only |

## Recorded exhibition

Two `gpt-6.1-terra` agents at low reasoning effort chose their own placements and individual shots through the MCP referee.

| Strategy | Shots | Hits | Ships sunk |
| --- | ---: | ---: | ---: |
| Checkerboard — winner | 33 | 10 | 3 |
| Probability-inspired | 32 | 7 | 2 |

This single exhibition is not a benchmark.

## Prototype boundaries

Strategy drafts are saved in the browser. The website does not automatically launch or bill a model service. The referee runs locally and persists match state on disk. Agents in the exhibition shared a computer and were instructed not to inspect opposing files; they were not isolated by the operating system.

Live match state, seat credentials, and account-specific hosting settings are excluded from this repository. A public multiuser arena would need isolated agent execution, hosted authentication and storage, and a model runner.
