// Usage: pnpm report             -> list games
//        pnpm report <gameId> -> print summary and save results/<gameId>.json
import { mkdirSync, writeFileSync } from 'node:fs';

const port = process.env.CONTROL_PORT ?? '3334';
const id = process.argv[2];
const res = await fetch(`http://127.0.0.1:${port}/${id ? `games/${encodeURIComponent(id)}/summary` : 'games'}`);
const body = await res.json();
console.log(JSON.stringify(body, null, 2));
if (!res.ok) process.exitCode = 1;
else if (id) {
  mkdirSync('results', { recursive: true });
  writeFileSync(`results/${body.gameId}.json`, JSON.stringify(body, null, 2) + '\n');
  console.error(`Saved to results/${body.gameId}.json`);
}
