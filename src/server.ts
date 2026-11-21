import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { GameError, Store } from './game.ts';

const MAX_WAIT_SECONDS = 25;
const BOARD_HTML = readFileSync(new URL('../public/index.html', import.meta.url.replace('/dist/', '/')), 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function log(entry: object) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

export function createMcpServer(store: Store): McpServer {
  const server = new McpServer({ name: 'mcp-tic-tac-toe', version: '1.0.0' });

  // Runs a tool, records timing on the game and maps GameError to an MCP tool error.
  async function run(tool: string, id: string | undefined, fn: () => object | Promise<object>) {
    const start = Date.now();
    let data: Record<string, unknown>;
    try {
      data = (await fn()) as Record<string, unknown>;
    } catch (e) {
      if (!(e instanceof GameError)) throw e;
      data = { ok: false, code: e.code, message: e.message };
    }
    const gameId = id ?? (data.gameId as string | undefined);
    const ok = data.ok !== false;
    const errorCode = ok ? undefined : (data.code as string);
    const durationMs = Date.now() - start;
    store.recordCall(gameId, { tool, at: start, durationMs, ok, errorCode });
    log({ event: 'tool_call', gameId: gameId ?? null, tool, durationMs, ok, errorCode: errorCode ?? null });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }], isError: !ok };
  }

  const gameId = z.string().min(1).max(64).describe('ID returned by start_game');

  server.registerTool(
    'start_game',
    {
      title: 'New tic-tac-toe game',
      description: 'Starts a tic-tac-toe game against a human. You are O. The first player alternates between games. Returns gameId, board and rules.',
      inputSchema: {},
    },
    () => run('start_game', undefined, () => store.start()),
  );

  server.registerTool(
    'get_board',
    {
      title: 'Get board',
      description:
        'Returns the board, free cells and whose turn it is. With waitSeconds (0-25) it waits on the server until the human moves or the time runs out; it never blocks longer.',
      inputSchema: {
        gameId,
        waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(0).describe('Maximum wait on the server, in seconds'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ gameId, waitSeconds }, extra) =>
      run('get_board', gameId, async () => {
        store.getBoard(gameId); // validate before waiting
        const deadline = Date.now() + waitSeconds * 1000;
        while (store.state(gameId) === 'WAITING_FOR_HUMAN' && Date.now() < deadline && !extra.signal.aborted) await sleep(250);
        if (extra.signal.aborted) throw new GameError('ABORTED', 'The client cancelled the request while waiting.');
        return store.getBoard(gameId);
      }),
  );

  server.registerTool(
    'play_move',
    {
      title: 'Play move',
      description: 'Plays O on a free cell (0-8). Only works on your turn. Optional short comment, shown to the human.',
      inputSchema: {
        gameId,
        cell: z.number().int().min(0).max(8).describe('Cell 0-8, left to right, top to bottom'),
        comment: z.string().trim().max(120).optional().describe('Short, friendly comment for the human'),
      },
    },
    ({ gameId, cell, comment }) => run('play_move', gameId, () => store.play(gameId, cell, comment)),
  );

  return server;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body, null, 2));
}

/** Public server: only /mcp/<secret> answers. Stateless: a fresh McpServer per request; state lives in Store. */
function publicHandler(store: Store, secret: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0];
    if (!safeEqual(path, `/mcp/${secret}`)) {
      log({ event: 'rejected', method: req.method, reason: 'unauthorized_path' }); // never log the path itself
      return json(res, 404, { error: 'not_found' });
    }
    const server = createMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      log({ event: 'mcp_error', message: (e as Error).message });
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    }
  };
}

/** Control server: loopback only, never exposed through ngrok. Serves the human's board. */
function controlHandler(store: Store, port: () => number) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const remote = req.socket.remoteAddress ?? '';
    const allowedHosts = [`127.0.0.1:${port()}`, `localhost:${port()}`];
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote);
    // Host check blocks DNS rebinding; Origin check blocks cross-site POSTs from other pages in the browser.
    const origin = req.headers.origin;
    const badOrigin = origin !== undefined && !allowedHosts.map((h) => `http://${h}`).includes(origin);
    // A forwarding proxy (e.g. ngrok --host-header=rewrite) can fake Host and loopback, but it adds x-forwarded-for.
    const forwarded = req.headers['x-forwarded-for'] !== undefined;
    if (!loopback || forwarded || !allowedHosts.includes(req.headers.host ?? '') || badOrigin) return json(res, 403, { error: 'forbidden' });

    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(BOARD_HTML);
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, store.boardState());
      if (req.method === 'POST' && url.pathname === '/api/move') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'json_only' });
        let body = '';
        for await (const chunk of req) {
          body += chunk;
          if (body.length > 256) return json(res, 413, { error: 'too_large' });
        }
        const { cell } = (JSON.parse(body) ?? {}) as { cell?: unknown };
        const state = store.humanMove(cell);
        log({ event: 'human_move', gameId: state.game?.id, cell, state: state.game?.state });
        return json(res, 200, state);
      }
      if (req.method === 'GET' && url.pathname === '/games') return json(res, 200, store.list());
      const m = url.pathname.match(/^\/games\/([^/]+)\/summary$/);
      if (req.method === 'GET' && m) return json(res, 200, store.summary(decodeURIComponent(m[1])));
      return json(res, 404, { error: 'not_found' });
    } catch (e) {
      if (e instanceof GameError) return json(res, 409, { code: e.code, message: e.message });
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid_json' });
      // Malformed URL, escape or body: answer 400 instead of crashing the process.
      if (!res.headersSent) json(res, 400, { error: 'bad_request' });
    }
  };
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

export async function startServers(opts: { store: Store; secret: string; port: number; controlPort: number }) {
  const publicServer = createServer(publicHandler(opts.store, opts.secret));
  let controlPortActual = 0;
  const controlServer = createServer(controlHandler(opts.store, () => controlPortActual));
  const port = await listen(publicServer, opts.port);
  controlPortActual = await listen(controlServer, opts.controlPort);
  return {
    port,
    controlPort: controlPortActual,
    close: async () => {
      publicServer.closeAllConnections();
      controlServer.closeAllConnections();
      await Promise.all([new Promise((r) => publicServer.close(r)), new Promise((r) => controlServer.close(r))]);
    },
  };
}
