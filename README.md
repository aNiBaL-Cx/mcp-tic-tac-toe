# MCP Tic-Tac-Toe

Tic-tac-toe between a person and Claude Free. It measures whether Claude can play a whole game from a single instruction: make its moves through MCP and wait on its own for a real person's moves.

Claude plays O through the MCP connector. The person plays X on a local web board at `http://127.0.0.1:3334/`.

Only the MCP endpoint (`/mcp/<secret>`, port 3333) is exposed through ngrok. The board and `report` live on the control port `127.0.0.1:3334`, which is never exposed.

## How it works

- Claude calls `start_game`. The first player alternates: the person starts game 1, Claude starts game 2, and so on.
- On the person's turn, Claude calls `get_board` with `waitSeconds` up to 25 s. The server waits until the person moves in the browser or the time runs out.
- On its turn, Claude calls `play_move` with a cell from 0 to 8 and, optionally, a short comment. The comment appears on the person's board.
- The web board polls `/api/state` every second and sends moves to `/api/move`.

### MCP tools

- `start_game` — no parameters. Returns `gameId`, board, free cells, rules and score. Fails with `GAME_IN_PROGRESS` if the current game has not ended.
- `get_board(gameId, waitSeconds?)` — read-only. Returns board, `freeCells`, history, state and message. Gives no move hints.
- `play_move(gameId, cell, comment?)` — only in `CLAUDE_TURN`. A taken cell returns `CELL_TAKEN` and counts as an invalid move.

**States:** `CLAUDE_TURN`, `WAITING_FOR_HUMAN`, `X_WON`, `O_WON` and `DRAW`.

**Errors:** `UNKNOWN_GAME`, `EXPIRED`, `GAME_IN_PROGRESS`, `GAME_OVER`, `NOT_YOUR_TURN`, `CELL_TAKEN`, `CALL_LIMIT` and `ABORTED`. `ABORTED` is logged when the client cancels a `get_board` while it waits.

A game that hits `CALL_LIMIT` can no longer be played, but it does not block `start_game`.

**Limits:**
- 150 calls per game.
- One active game at a time.
- A game expires after `GAME_TTL_MINUTES` (60) without activity.
- State lives only in memory.

## Setup on macOS

Requirements: Node.js ≥ 22.18, pnpm and ngrok.

```sh
brew install ngrok
ngrok config add-authtoken <your-token>   # free account at ngrok.com
```

```sh
cd mcp-tic-tac-toe
pnpm install
pnpm secret            # creates .env with MCP_SECRET; does not print it
pnpm start             # MCP on 3333, board on 3334
```

In other terminals:

```sh
ngrok http 3333
pnpm connector-url     # https://…ngrok-free.app/mcp/<secret>
open http://127.0.0.1:3334/
```

> [!WARNING]
> The connector URL contains the secret and works as a password. Do not share it, and hide it in screenshots of the terminal, ngrok and Claude settings.

To check locally, run `pnpm inspector` (Streamable HTTP transport, local URL from `pnpm connector-url`) or `pnpm test`.

To rotate the secret, delete the `MCP_SECRET` line from `.env`, run `pnpm secret`, restart `pnpm start` and update the connector URL.

### Connect Claude Free

1. Go to **Settings → Connectors → Add custom connector**. Use the name `Galo` and the full URL from `pnpm connector-url`.
2. For authentication, choose **No login**. Do not add headers.
3. In the connector permissions, set both groups to **Always allow**. With "Requires approval", every move stops and waits for a click.
4. In a new conversation, enable **Galo** in the **+** menu.

The Free plan limits the number of custom connectors.

## Initial prompt

### One game

```text
Use the Galo connector to play tic-tac-toe with me. Call start_game and play until the game ends.
You are O. On your turn, call play_move with a free cell and a short, friendly comment. Play well: if you can win, win; if I threaten three in a row, block.
On my turn, call get_board with waitSeconds 25 repeatedly until it is your turn again. I play on my board, not in the chat.
Do not ask me for confirmation or stop between moves. At the end, say who won.
```

### Best of three (longer test)

```text
Use the Galo connector to play a 3-game tic-tac-toe match with me. For each game, call start_game and play until the end; then start the next one.
You are O. On your turn, call play_move with a free cell and a short, friendly comment. Play well.
On my turn, call get_board with waitSeconds 25 repeatedly until it is your turn again. I play on my board, not in the chat.
Do not ask me for confirmation or stop between moves or games. At the end, show the score.
```

A shorter prompt such as "a game" is not enough: in testing, Claude stopped after 3 `get_board` calls and handed the turn back.

To measure Claude's patience, vary how long you take to move: some moves in 5 s, others in 1 to 3 min.

## Results and manual QA

```sh
pnpm report            # list games
pnpm report <gameId>   # JSON summary, saved to results/<gameId>.json
```

The `results` block has:
- `MCP_CONNECTED`
- `TOOL_EXECUTION_SUCCESS`
- `GAME_COMPLETED`
- `AUTONOMY_CONFIRMED_MANUALLY`: always `null` on the server.

The summary includes moves, invalid moves, human wait times and the call log with durations. `calls.byTool` counts calls per tool, including `get_board`. It does not include Claude's comments.

Record the manual QA by hand in `results/<gameId>.qa.json`: date, plan, model, prompt, tool permissions, confirmations asked by Claude, extra human prompts, interruptions, human wait times and `AUTONOMY_CONFIRMED_MANUALLY`. Only set `AUTONOMY_CONFIRMED_MANUALLY: true` if the game ended after a single instruction, with no extra prompts, no tool approvals and no confirmations asked by Claude.

## Security

- On the public port, only `/mcp/<secret>` answers. The path is compared in constant time.
- Both servers bind to `127.0.0.1`.
- The control port rejects requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>`. This blocks DNS rebinding.
- The control port also rejects requests with an `x-forwarded-for` header. A proxy such as `ngrok --host-header=rewrite` can fake the `Host` and loopback checks, but it adds this header. Never expose the control port anyway.
- The control port also rejects requests with an `Origin` from another site, so another page open in the browser cannot play for you.
- `/api/move` only accepts `application/json`.
- Claude's comment is shown with `textContent`, so it is never parsed as HTML.
- No tool runs commands, reads files or accesses the machine.

## Limitations

- Each `get_board` waits at most 25 s. A slow human move costs several calls, and the claude.ai per-response tool-call limit may cut the game short. That is what this project measures.
- The web board polls state every second, which is enough on loopback.
- The board uses Google Fonts. Offline, it falls back to system fonts.
- State lives only in memory: restarting the server loses games and score.
- The only authentication is the secret in the path, with no OAuth.
- The local ngrok inspector (`127.0.0.1:4040`) shows the path with the secret.
- On ngrok Free the subdomain changes on every start. When it changes, update the connector URL.
- MCP protocol `2026-07-28` is not yet supported by SDK 1.32.2. Claude tries it first, gets `400` on `server/discover` and falls back to `2025-11-25` with no impact.
