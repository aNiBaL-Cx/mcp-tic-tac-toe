// Creates .env from .env.example with a random MCP_SECRET. Never prints the secret.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const env = existsSync('.env') ? readFileSync('.env', 'utf8') : readFileSync('.env.example', 'utf8');
if (/^MCP_SECRET=\S{32,}$/m.test(env)) {
  console.log('.env já tem MCP_SECRET. Para rodar o segredo, apague a linha e volte a correr pnpm secret.');
} else {
  const secret = randomBytes(32).toString('base64url');
  const next = /^MCP_SECRET=.*$/m.test(env) ? env.replace(/^MCP_SECRET=.*$/m, `MCP_SECRET=${secret}`) : `${env}\nMCP_SECRET=${secret}\n`;
  writeFileSync('.env', next, { mode: 0o600 });
  console.log('MCP_SECRET gerado em .env (não é mostrado aqui).');
}
