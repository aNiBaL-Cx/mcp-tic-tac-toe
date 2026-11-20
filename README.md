# MCP Tic-Tac-Toe

Jogo do galo entre uma pessoa e o Claude Free, para medir se o Claude consegue jogar um jogo inteiro a partir de uma única instrução: fazer as suas jogadas por MCP e esperar sozinho pelas jogadas de uma pessoa real.

É a continuação do `mcp-prime-challenge`. Em vez de `pnpm human:play`, a pessoa joga num tabuleiro web local. O Claude joga O pelo conector MCP. A pessoa joga X no browser, em `http://127.0.0.1:3334/`.

Só o endpoint MCP (`/mcp/<secret>`, porta 3333) é exposto via ngrok. O tabuleiro e o `report` ficam na porta de controlo `127.0.0.1:3334`, que nunca é exposta.

## Como funciona

- O Claude chama `start_game`. Quem começa alterna: o jogo 1 começa a pessoa, o jogo 2 o Claude, e assim por diante.
- Na vez da pessoa, o Claude chama `get_board` com `waitSeconds` até 25 s. O servidor espera até a pessoa jogar no browser ou o tempo acabar.
- Na vez do Claude, ele chama `play_move` com uma casa de 0 a 8 e, opcionalmente, um comentário curto. O comentário aparece no tabuleiro da pessoa.
- O tabuleiro web consulta `/api/state` a cada segundo e envia as jogadas para `/api/move`.

### Ferramentas MCP

- `start_game` — sem parâmetros. Devolve `gameId`, tabuleiro, casas livres, regras e placar. Recusa com `GAME_IN_PROGRESS` se o jogo atual ainda não terminou.
- `get_board(gameId, waitSeconds?)` — só leitura. Devolve tabuleiro, `freeCells`, histórico, estado e mensagem. Não dá dicas de jogada.
- `play_move(gameId, cell, comment?)` — só em `CLAUDE_TURN`. Uma casa ocupada devolve `CELL_TAKEN` e conta como jogada inválida.

**Estados:** `CLAUDE_TURN`, `WAITING_FOR_HUMAN`, `X_WON`, `O_WON` e `DRAW`.

**Erros:** `UNKNOWN_GAME`, `EXPIRED`, `GAME_IN_PROGRESS`, `GAME_OVER`, `NOT_YOUR_TURN`, `CELL_TAKEN` e `CALL_LIMIT`.

**Limites:**
- 150 chamadas por jogo.
- Um jogo ativo de cada vez.
- Um jogo expira após `GAME_TTL_MINUTES` (60) sem atividade.
- O estado vive só em memória.

## Setup em macOS

Requisitos: Node.js ≥ 22.18, pnpm e ngrok. Instala e configura o ngrok como no README do `mcp-prime-challenge`, com `brew install ngrok` e `ngrok config add-authtoken`.

```sh
cd mcp-tic-tac-toe
pnpm install
pnpm secret            # cria .env com MCP_SECRET; não o imprime
pnpm start             # MCP em 3333, tabuleiro em 3334
```

Noutros terminais:

```sh
ngrok http 3333
pnpm connector-url     # https://…ngrok-free.app/mcp/<secret>
open http://127.0.0.1:3334/
```

> [!WARNING]
> O URL do conector contém o segredo e funciona como password. Não o partilhes e tapa-o em screenshots do terminal, do ngrok e das definições do Claude. Este projeto tem um segredo próprio, diferente do do `mcp-prime-challenge`.

Para verificar localmente, corre `pnpm inspector` (transporte Streamable HTTP, URL local de `pnpm connector-url`) ou `pnpm test`.

### Ligar ao Claude Free

1. **Settings → Connectors → Add custom connector**. Usa o nome `Galo` e o URL completo de `pnpm connector-url`.
2. Em autenticação, escolhe **Sem login**. Não adiciones cabeçalhos.
3. Nas permissões do conector, põe os dois grupos em **Sempre permitir**. Com "Requer aprovação", cada jogada fica parada à espera de um clique.
4. Numa conversa nova, ativa **Galo** no menu **+**.

O plano Free limita o número de conectores personalizados. Se o `Primos` ainda existir, remove-o primeiro.

## Prompt inicial

### Um jogo

```text
Usa o conector Galo para jogar comigo ao jogo do galo. Chama start_game e joga até o jogo terminar.
Tu és O. Na tua vez, chama play_move com uma casa livre e um comentário curto e bem-disposto em português de Portugal. Joga bem: se podes ganhar, ganha; se eu ameaço três em linha, bloqueia.
Na minha vez, chama get_board com waitSeconds 25 repetidamente até voltar a ser a tua vez. Eu jogo no meu tabuleiro, não no chat.
Não me peças confirmação nem pares entre jogadas. No fim, diz quem ganhou.
```

### Melhor de três (teste mais longo)

```text
Usa o conector Galo para jogar comigo uma partida de 3 jogos do galo. Para cada jogo, chama start_game e joga até ao fim; depois começa o seguinte.
Tu és O. Na tua vez, chama play_move com uma casa livre e um comentário curto e bem-disposto em português de Portugal. Joga bem.
Na minha vez, chama get_board com waitSeconds 25 repetidamente até voltar a ser a tua vez. Eu jogo no meu tabuleiro, não no chat.
Não me peças confirmação nem pares entre jogadas ou entre jogos. No fim, mostra o placar.
```

Para medir a paciência do Claude, varia o tempo que demoras a jogar: umas jogadas em 5 s, outras em 1 a 3 min.

## Resultados e QA manual

```sh
pnpm report            # lista jogos
pnpm report <gameId>   # resumo JSON, gravado em results/<gameId>.json
```

O bloco `results` tem:
- `MCP_CONNECTED`
- `TOOL_EXECUTION_SUCCESS`
- `GAME_COMPLETED`
- `AUTONOMY_CONFIRMED_MANUALLY`: sempre `null` no servidor.

O resumo inclui jogadas, jogadas inválidas, chamadas a `get_board`, tempos de espera pela pessoa e o registo de chamadas com duração. Não inclui os comentários do Claude.

Regista o QA à mão em `results/<gameId>.qa.json`, com o mesmo formato do `mcp-prime-challenge`. Só marques `AUTONOMY_CONFIRMED_MANUALLY: true` se o jogo terminou depois de uma única instrução, sem prompts extra e sem confirmações pedidas pelo Claude.

## Segurança

- Na porta pública, só `/mcp/<secret>` responde. A comparação do caminho é feita em tempo constante.
- Os dois servidores fazem bind a `127.0.0.1`.
- A porta de controlo rejeita pedidos com um `Host` que não seja `127.0.0.1:<porta>` ou `localhost:<porta>`. Isto bloqueia DNS rebinding e pedidos reencaminhados.
- A porta de controlo também rejeita pedidos com `Origin` de outro site, para que outra página aberta no browser não possa jogar por ti.
- `/api/move` só aceita `application/json`.
- O comentário do Claude é mostrado com `textContent`, por isso nunca é interpretado como HTML.
- Não há ferramentas que executem comandos, leiam ficheiros ou acedam à máquina.

## Limitações

- Cada `get_board` espera no máximo 25 s. Uma jogada lenta da pessoa custa várias chamadas, e o limite de chamadas por resposta do claude.ai pode cortar o jogo. É isso que se quer medir.
- O tabuleiro web consulta o estado a cada segundo, o que basta em loopback.
- O tabuleiro usa Google Fonts. Sem internet, cai nas fontes do sistema.
- O estado vive só em memória: reiniciar o servidor perde os jogos e o placar.
- A única autenticação é o segredo no caminho, sem OAuth.
- O inspetor local do ngrok (`127.0.0.1:4040`) mostra o caminho com o segredo.
- No ngrok Free o subdomínio muda a cada arranque. Quando mudar, atualiza o URL do conector.
- O protocolo MCP `2026-07-28` ainda não é suportado pelo SDK 1.32.2. O Claude tenta-o primeiro, recebe `400` em `server/discover` e passa para `2025-11-25` sem impacto.
