// Prints the full connector URL (ngrok HTTPS + /mcp/<secret>). Contains the secret: do not paste it anywhere public.
const secret = process.env.MCP_SECRET;
if (!secret) throw new Error('MCP_SECRET em falta. Corra: pnpm secret');
const port = process.env.PORT ?? '3333';
let base = '';
try {
  const res = await fetch('http://127.0.0.1:4040/api/tunnels');
  const { tunnels } = (await res.json()) as { tunnels: { public_url: string; config: { addr: string } }[] };
  base = tunnels.find((t) => t.public_url.startsWith('https://') && t.config.addr.endsWith(`:${port}`))?.public_url ?? '';
} catch {}
if (base) console.log(`${base}/mcp/${secret}`);
else console.log(`ngrok não encontrado em 127.0.0.1:4040. Local: http://127.0.0.1:${port}/mcp/${secret}`);
