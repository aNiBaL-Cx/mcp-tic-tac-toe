import { Store } from './game.ts';
import { startServers } from './server.ts';

const secret = process.env.MCP_SECRET ?? '';
if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
  console.error('MCP_SECRET missing or weak (at least 32 characters of [A-Za-z0-9_-]). Run: pnpm secret');
  process.exit(1);
}

const store = new Store({ ttlMinutes: Number(process.env.GAME_TTL_MINUTES ?? 60) });
const { port, controlPort } = await startServers({
  store,
  secret,
  port: Number(process.env.PORT ?? 3333),
  controlPort: Number(process.env.CONTROL_PORT ?? 3334),
});

console.log(`MCP endpoint:     http://127.0.0.1:${port}/mcp/<secret>   (expose only this port: ngrok http ${port})`);
console.log(`Human board:      http://127.0.0.1:${controlPort}/   (local only, never expose)`);
console.log('Full connector URL: pnpm connector-url');
