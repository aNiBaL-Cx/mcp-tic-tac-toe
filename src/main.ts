import { Store } from './game.ts';
import { startServers } from './server.ts';

const secret = process.env.MCP_SECRET ?? '';
if (!/^[A-Za-z0-9_-]{32,}$/.test(secret)) {
  console.error('MCP_SECRET em falta ou fraco (mínimo 32 caracteres [A-Za-z0-9_-]). Corra: pnpm secret');
  process.exit(1);
}

const store = new Store({ ttlMinutes: Number(process.env.GAME_TTL_MINUTES ?? 60) });
const { port, controlPort } = await startServers({
  store,
  secret,
  port: Number(process.env.PORT ?? 3333),
  controlPort: Number(process.env.CONTROL_PORT ?? 3334),
});

console.log(`MCP endpoint:     http://127.0.0.1:${port}/mcp/<secret>   (exponha só esta porta: ngrok http ${port})`);
console.log(`Tabuleiro humano: http://127.0.0.1:${controlPort}/   (só local, nunca expor)`);
console.log('URL completo do conector: pnpm connector-url');
