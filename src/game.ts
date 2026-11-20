import { randomUUID } from 'node:crypto';

export const MAX_CALLS_PER_GAME = 150;

const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];

export type Mark = 'X' | 'O';
export type GameState = 'CLAUDE_TURN' | 'WAITING_FOR_HUMAN' | 'X_WON' | 'O_WON' | 'DRAW';

export class GameError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

interface CallRecord {
  tool: string;
  at: number;
  durationMs: number;
  ok: boolean;
  errorCode?: string;
}

interface Game {
  id: string;
  number: number;
  createdAt: number;
  lastActivityAt: number;
  endedAt?: number;
  startedBy: 'HUMAN' | 'CLAUDE';
  board: (Mark | null)[];
  state: GameState;
  winLine: number[] | null;
  history: { who: Mark; cell: number; at: number }[];
  comment: string;
  waitingSince?: number;
  humanWaitMs: number[];
  invalidMoves: number;
  getBoardCalls: number;
  calls: CallRecord[];
}

const ENDED: GameState[] = ['X_WON', 'O_WON', 'DRAW'];

function outcome(board: (Mark | null)[]): { state: GameState; line: number[] | null } | null {
  for (const l of LINES) {
    const [a, b, c] = l;
    if (board[a] && board[a] === board[b] && board[a] === board[c]) return { state: board[a] === 'X' ? 'X_WON' : 'O_WON', line: l };
  }
  return board.every(Boolean) ? { state: 'DRAW', line: null } : null;
}

export function boardText(board: (Mark | null)[]): string {
  const c = (i: number) => board[i] ?? String(i);
  return [0, 3, 6].map((r) => `${c(r)} | ${c(r + 1)} | ${c(r + 2)}`).join('\n---------\n');
}

export class Store {
  private games = new Map<string, Game>();
  private ttlMs: number;
  private now: () => number;

  constructor(opts: { ttlMinutes?: number; now?: () => number } = {}) {
    this.ttlMs = (opts.ttlMinutes ?? 60) * 60_000;
    this.now = opts.now ?? Date.now;
  }

  private isExpired(g: Game): boolean {
    return !ENDED.includes(g.state) && this.now() - g.lastActivityAt > this.ttlMs;
  }

  private latest(): Game | undefined {
    return [...this.games.values()].at(-1);
  }

  private get(id: string): Game {
    const g = this.games.get(id);
    if (!g) throw new GameError('UNKNOWN_GAME', `Jogo "${id}" não existe. Usa start_game.`);
    if (this.isExpired(g)) throw new GameError('EXPIRED', 'Jogo expirou por inatividade. Usa start_game.');
    if (g.calls.length >= MAX_CALLS_PER_GAME) throw new GameError('CALL_LIMIT', `Limite de ${MAX_CALLS_PER_GAME} chamadas atingido neste jogo.`);
    return g;
  }

  private place(g: Game, cell: number, who: Mark) {
    const now = this.now();
    g.board[cell] = who;
    g.history.push({ who, cell, at: now });
    g.lastActivityAt = now;
    const end = outcome(g.board);
    if (end) {
      g.state = end.state;
      g.winLine = end.line;
      g.endedAt = now;
      g.waitingSince = undefined;
    } else if (who === 'O') {
      g.state = 'WAITING_FOR_HUMAN';
      g.waitingSince = now;
    } else {
      g.state = 'CLAUDE_TURN';
    }
  }

  private message(g: Game): string {
    switch (g.state) {
      case 'CLAUDE_TURN':
        return 'É a tua vez (O). Chama play_move com uma casa livre.';
      case 'WAITING_FOR_HUMAN':
        return 'Vez do humano (X). Chama get_board com waitSeconds 25 até voltar a ser a tua vez. Não precisas de confirmação do utilizador.';
      case 'X_WON':
        return 'O humano (X) ganhou. Jogo terminado.';
      case 'O_WON':
        return 'Ganhaste (O). Jogo terminado.';
      default:
        return 'Empate. Jogo terminado.';
    }
  }

  /** What Claude sees. No hints about the best move. */
  private view(g: Game) {
    return {
      gameId: g.id,
      gameNumber: g.number,
      you: 'O',
      human: 'X',
      state: g.state,
      board: boardText(g.board),
      freeCells: g.board.flatMap((v, i) => (v ? [] : [i])),
      history: g.history.map((h, n) => `${n + 1}. ${h.who === 'X' ? 'Humano (X)' : 'Claude (O)'} na casa ${h.cell}`),
      score: this.score(),
      message: this.message(g),
    };
  }

  score() {
    const s = { human: 0, claude: 0, draws: 0 };
    for (const g of this.games.values()) {
      if (g.state === 'X_WON') s.human++;
      else if (g.state === 'O_WON') s.claude++;
      else if (g.state === 'DRAW') s.draws++;
    }
    return s;
  }

  start() {
    const cur = this.latest();
    if (cur && !ENDED.includes(cur.state) && !this.isExpired(cur))
      throw new GameError('GAME_IN_PROGRESS', `O jogo ${cur.id} ainda não terminou. Continua-o com get_board / play_move.`);
    const now = this.now();
    const number = this.games.size + 1;
    // Starting player alternates: game 1 human, game 2 Claude, ...
    const startedBy = number % 2 === 1 ? 'HUMAN' : 'CLAUDE';
    const g: Game = {
      id: randomUUID(),
      number,
      createdAt: now,
      lastActivityAt: now,
      startedBy,
      board: Array(9).fill(null),
      state: startedBy === 'HUMAN' ? 'WAITING_FOR_HUMAN' : 'CLAUDE_TURN',
      winLine: null,
      history: [],
      comment: '',
      waitingSince: startedBy === 'HUMAN' ? now : undefined,
      humanWaitMs: [],
      invalidMoves: 0,
      getBoardCalls: 0,
      calls: [],
    };
    this.games.set(g.id, g);
    return {
      ...this.view(g),
      rules: [
        'Jogo do galo 3x3. Tu és O, o humano é X. Casas numeradas 0-8, da esquerda para a direita, de cima para baixo.',
        'O humano joga num tabuleiro web local; tu jogas com play_move.',
        'Quando for a vez do humano, chama get_board com waitSeconds 25 repetidamente até ser a tua vez.',
        'Continua até o jogo terminar, sem pedir confirmação ao utilizador.',
      ],
    };
  }

  getBoard(id: string) {
    const g = this.get(id);
    g.getBoardCalls++;
    if (!ENDED.includes(g.state)) g.lastActivityAt = this.now();
    return this.view(g);
  }

  state(id: string): GameState | null {
    return this.games.get(id)?.state ?? null;
  }

  play(id: string, cell: number, comment = '') {
    const g = this.get(id);
    if (ENDED.includes(g.state)) throw new GameError('GAME_OVER', 'O jogo já terminou. Usa start_game para outro.');
    if (g.state !== 'CLAUDE_TURN') throw new GameError('NOT_YOUR_TURN', 'Não é a tua vez: o humano ainda não jogou. Usa get_board com waitSeconds.');
    if (g.board[cell] !== null) {
      g.invalidMoves++;
      return { ...this.view(g), ok: false, code: 'CELL_TAKEN', message: `A casa ${cell} já está ocupada. Escolhe uma de freeCells.` };
    }
    g.comment = comment;
    this.place(g, cell, 'O');
    return { ok: true, result: 'MOVE_ACCEPTED', ...this.view(g) };
  }

  /** Human move from the loopback web board. Always applies to the latest game. */
  humanMove(cell: number) {
    const g = this.latest();
    if (!g || this.isExpired(g)) throw new GameError('NO_GAME', 'Não há jogo ativo. Pede ao Claude para chamar start_game.');
    if (g.state !== 'WAITING_FOR_HUMAN') throw new GameError('NOT_HUMAN_TURN', 'Não é a tua vez.');
    if (!Number.isInteger(cell) || cell < 0 || cell > 8 || g.board[cell] !== null) throw new GameError('INVALID_CELL', 'Casa inválida.');
    g.humanWaitMs.push(this.now() - (g.waitingSince ?? this.now()));
    this.place(g, cell, 'X');
    return this.boardState();
  }

  /** What the local web board sees. */
  boardState() {
    const g = this.latest();
    if (!g) return { game: null, score: this.score() };
    return {
      game: {
        id: g.id,
        number: g.number,
        board: g.board,
        state: this.isExpired(g) ? 'EXPIRED' : g.state,
        winLine: g.winLine,
        comment: g.comment,
        startedBy: g.startedBy,
      },
      score: this.score(),
    };
  }

  recordCall(id: string | undefined, rec: CallRecord) {
    const g = id ? this.games.get(id) : undefined;
    if (g && rec.errorCode !== 'CALL_LIMIT') g.calls.push(rec);
  }

  list() {
    return [...this.games.values()].map((g) => ({
      gameId: g.id,
      number: g.number,
      state: g.state,
      expired: this.isExpired(g),
      lastActivityAt: new Date(g.lastActivityAt).toISOString(),
    }));
  }

  /** Final JSON summary. No secret, no Claude comments. */
  summary(id: string) {
    const g = this.games.get(id);
    if (!g) throw new GameError('UNKNOWN_GAME', `Jogo "${id}" não existe.`);
    const ended = ENDED.includes(g.state);
    const result = ended ? 'COMPLETED' : this.isExpired(g) ? 'ABANDONED' : 'IN_PROGRESS';
    const end = g.endedAt ?? (result === 'ABANDONED' ? g.lastActivityAt : this.now());
    const byTool: Record<string, number> = {};
    for (const r of g.calls) byTool[r.tool] = (byTool[r.tool] ?? 0) + 1;
    const iso = (t?: number) => (t === undefined ? null : new Date(t).toISOString());
    return {
      gameId: g.id,
      gameNumber: g.number,
      result,
      finalState: g.state,
      startedBy: g.startedBy,
      startedAt: iso(g.createdAt),
      endedAt: result === 'IN_PROGRESS' ? null : iso(end),
      totalDurationMs: end - g.createdAt,
      finalBoard: boardText(g.board),
      moves: g.history.map((h) => ({ who: h.who, cell: h.cell, at: iso(h.at) })),
      invalidMoves: g.invalidMoves,
      getBoardCalls: g.getBoardCalls,
      humanWaitMs: g.humanWaitMs,
      totalHumanWaitMs: g.humanWaitMs.reduce((a, b) => a + b, 0),
      calls: {
        total: g.calls.length,
        failed: g.calls.filter((r) => !r.ok).length,
        byTool,
        log: g.calls.map((r) => ({ tool: r.tool, at: iso(r.at), durationMs: r.durationMs, ok: r.ok, errorCode: r.errorCode ?? null })),
      },
      results: {
        MCP_CONNECTED: g.calls.length > 0,
        TOOL_EXECUTION_SUCCESS: g.calls.some((r) => r.ok),
        GAME_COMPLETED: ended,
        AUTONOMY_CONFIRMED_MANUALLY: null,
        note: 'AUTONOMY_CONFIRMED_MANUALLY is never set by the server. Fill it from the manual QA record after observing the Claude conversation.',
      },
    };
  }
}
