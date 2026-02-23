import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from 'pino';
import { sql } from './supabase.js';
import type {
  PlayerSummary,
  PlayerProfile,
  ProfitPoint,
  ShowdownEntry,
  ScoutPlayer,
} from './types.js';
import { HttpClient } from './http.js';
import { PLAYER_STACKS_REGEX, PLAYER_STACK_ENTRY_REGEX } from './parser.js';

const PORT = parseInt(process.env.PORT || '3456', 10);

function jsonOk(res: ServerResponse, data: unknown): void {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function jsonErr(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ error: message }));
}

function getPath(req: IncomingMessage): string {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);
  return url.pathname;
}

const PROFIT_CTES = `
  tracked_per_player_hand AS (
    SELECT player_id, hand_id, SUM(street_max) AS tracked_cost
    FROM (
      SELECT player_id, hand_id, street,
             MAX(COALESCE(amount, 0)) AS street_max
      FROM pn_actions
      WHERE action IN ('calls','bets','raise','post big blind','post small blind')
        AND player_id IS NOT NULL
      GROUP BY player_id, hand_id, street
    ) s
    GROUP BY player_id, hand_id
  ),
  total_tracked_per_hand AS (
    SELECT hand_id, SUM(tracked_cost) AS total_tracked
    FROM tracked_per_player_hand
    GROUP BY hand_id
  ),
  collected_per_player_hand AS (
    SELECT player_id, hand_id, MAX(amount) AS collected
    FROM pn_actions
    WHERE action = 'collected' AND player_id IS NOT NULL
    GROUP BY player_id, hand_id
  ),
  pot_per_hand AS (
    SELECT hand_id,
           SUM(collected)  AS pot,
           COUNT(*)        AS winner_count
    FROM collected_per_player_hand
    GROUP BY hand_id
  ),
  corrected_costs AS (
    SELECT c.player_id, c.hand_id,
           CASE
             WHEN p.winner_count = 1 AND col.collected IS NOT NULL THEN
               GREATEST(0, c.tracked_cost - GREATEST(0, t.total_tracked - p.pot))
             ELSE
               c.tracked_cost
           END AS actual_cost
    FROM tracked_per_player_hand c
    JOIN  total_tracked_per_hand t   ON t.hand_id  = c.hand_id
    JOIN  pot_per_hand           p   ON p.hand_id  = c.hand_id
    LEFT JOIN collected_per_player_hand col
                                     ON col.hand_id = c.hand_id
                                    AND col.player_id = c.player_id
  ),
  costs AS (
    SELECT player_id, SUM(actual_cost) AS total_cost
    FROM corrected_costs
    GROUP BY player_id
  ),
  collected_dedup AS (
    SELECT player_id, SUM(collected) AS total_collected
    FROM collected_per_player_hand
    GROUP BY player_id
  ),
  profit AS (
    SELECT
      COALESCE(c.player_id, cd.player_id) AS player_id,
      ROUND((COALESCE(cd.total_collected, 0) - COALESCE(c.total_cost, 0))::numeric, 2) AS net
    FROM costs c
    FULL JOIN collected_dedup cd ON cd.player_id = c.player_id
  )
`;

function playersCTE(where = ''): string {
  return `
WITH
  ${PROFIT_CTES},
  base   AS (SELECT player_id, MAX(player_display) AS player_display,
                    COUNT(DISTINCT hand_id) AS hands_played
             FROM pn_actions WHERE player_id IS NOT NULL GROUP BY player_id),
  vpip   AS (SELECT player_id, COUNT(DISTINCT hand_id) AS n
             FROM pn_actions WHERE street='preflop' AND action IN ('calls','raise','bets')
               AND player_id IS NOT NULL GROUP BY player_id),
  pfr    AS (SELECT player_id, COUNT(DISTINCT hand_id) AS n
             FROM pn_actions WHERE street='preflop' AND action='raise'
               AND player_id IS NOT NULL GROUP BY player_id),
  agg    AS (SELECT player_id,
               COUNT(CASE WHEN action IN ('bets','raise') THEN 1 END) AS num,
               COUNT(CASE WHEN action IN ('bets','raise','calls') THEN 1 END) AS den
             FROM pn_actions WHERE player_id IS NOT NULL GROUP BY player_id),
  sd     AS (SELECT player_id, COUNT(DISTINCT hand_id) AS n
             FROM pn_actions WHERE action LIKE 'shows%' AND player_id IS NOT NULL GROUP BY player_id)
SELECT b.player_id, b.player_display, b.hands_played::int,
  ROUND(100.0*COALESCE(v.n,0)/NULLIF(b.hands_played,0),1)::float  AS vpip_pct,
  ROUND(100.0*COALESCE(p.n,0)/NULLIF(b.hands_played,0),1)::float  AS pfr_pct,
  ROUND(100.0*COALESCE(a.num,0)/NULLIF(a.den,0),1)::float         AS aggression_pct,
  ROUND(100.0*COALESCE(sd.n,0)/NULLIF(b.hands_played,0),1)::float AS showdown_pct,
  ROUND(COALESCE(pr.net,0)::numeric,2)::float                     AS net_profit,
  CASE
    WHEN ROUND(100.0*COALESCE(v.n,0)/NULLIF(b.hands_played,0),1) < 35
     AND ROUND(100.0*COALESCE(a.num,0)/NULLIF(a.den,0),1) > 50 THEN 'TAG'
    WHEN ROUND(100.0*COALESCE(v.n,0)/NULLIF(b.hands_played,0),1) >= 35
     AND ROUND(100.0*COALESCE(a.num,0)/NULLIF(a.den,0),1) > 50 THEN 'LAG'
    WHEN ROUND(100.0*COALESCE(v.n,0)/NULLIF(b.hands_played,0),1) >= 35
     AND ROUND(100.0*COALESCE(a.num,0)/NULLIF(a.den,0),1) <= 50 THEN 'LAP'
    ELSE 'Passive'
  END AS style_label
FROM base b
LEFT JOIN vpip v  ON v.player_id=b.player_id
LEFT JOIN pfr  p  ON p.player_id=b.player_id
LEFT JOIN agg  a  ON a.player_id=b.player_id
LEFT JOIN sd  sd  ON sd.player_id=b.player_id
LEFT JOIN profit pr ON pr.player_id=b.player_id
${where}
ORDER BY b.hands_played DESC
`.trim();
}

async function handleOverview(res: ServerResponse): Promise<void> {
  const [rows] = await sql<{
    total_hands: number;
    total_players: number;
    total_actions: number;
    avg_actions_per_hand: number;
  }>(`
    SELECT
      COUNT(DISTINCT hand_id)   AS total_hands,
      COUNT(DISTINCT player_id) AS total_players,
      COUNT(*)                  AS total_actions,
      ROUND(COUNT(*)::numeric / NULLIF(COUNT(DISTINCT hand_id),0), 1)::float
                                AS avg_actions_per_hand
    FROM pn_actions
    WHERE player_id IS NOT NULL
  `);
  jsonOk(res, rows);
}

async function handleFunnel(res: ServerResponse): Promise<void> {
  const rows = await sql<{ street: string; hands: number }>(`
    SELECT street,
           COUNT(DISTINCT hand_id) AS hands
    FROM pn_actions
    WHERE street IN ('preflop','flop','turn','river','showdown')
    GROUP BY street
    ORDER BY CASE street
      WHEN 'preflop'  THEN 1
      WHEN 'flop'     THEN 2
      WHEN 'turn'     THEN 3
      WHEN 'river'    THEN 4
      WHEN 'showdown' THEN 5
    END
  `);
  jsonOk(res, rows);
}

async function handlePots(res: ServerResponse): Promise<void> {
  const rows = await sql<{ bucket: string; count: number }>(`
    SELECT
      CASE
        WHEN amount <   50  THEN '0-50'
        WHEN amount <  100  THEN '50-100'
        WHEN amount <  250  THEN '100-250'
        WHEN amount <  500  THEN '250-500'
        WHEN amount < 1000  THEN '500-1000'
        ELSE '1000+'
      END AS bucket,
      COUNT(*) AS count
    FROM pn_actions
    WHERE action = 'collected' AND amount IS NOT NULL
    GROUP BY bucket
    ORDER BY MIN(amount)
  `);
  jsonOk(res, rows);
}

async function handleActions(res: ServerResponse): Promise<void> {
  const rows = await sql<{ action_label: string; count: number }>(`
    SELECT
      CASE
        WHEN action = 'folds'            THEN 'Fold'
        WHEN action = 'checks'           THEN 'Check'
        WHEN action = 'calls'            THEN 'Call'
        WHEN action IN ('bets','raise')  THEN 'Bet/Raise'
        WHEN action = 'collected'        THEN 'Collected'
        WHEN action LIKE 'post%'         THEN 'Blind'
        WHEN action LIKE 'shows%'        THEN 'Showdown'
        ELSE 'Other'
      END AS action_label,
      COUNT(*) AS count
    FROM pn_actions
    GROUP BY 1
    ORDER BY count DESC
  `);
  jsonOk(res, rows);
}

async function handlePlayers(res: ServerResponse): Promise<void> {
  const rows = await sql<PlayerSummary>(playersCTE());
  jsonOk(res, rows);
}

async function fetchMedianBB(): Promise<number> {
  const rows = await sql<{ median_bb: number }>(`
    SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount) AS median_bb
    FROM pn_actions
    WHERE action = 'post big blind' AND amount IS NOT NULL AND amount > 0
  `);
  return rows[0]?.median_bb ?? 1;
}

async function handlePlayer(res: ServerResponse, playerId: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(playerId)) {
    jsonErr(res, 400, 'Invalid player_id format');
    return;
  }

  const escapedId = playerId.replace(/'/g, "''");

  const [statsRows, trendRows, showdownRows, breakdownRows, medianBBRows] = await Promise.all([
    sql<PlayerSummary>(playersCTE(`WHERE b.player_id = '${escapedId}'`)),

    sql<{ hand_order: number; cumulative_profit: number }>(`
      WITH
        hand_tracked AS (
          SELECT hand_id, SUM(street_max) AS tracked_cost
          FROM (
            SELECT hand_id, street, MAX(COALESCE(amount, 0)) AS street_max
            FROM pn_actions
            WHERE action IN ('calls','bets','raise','post big blind','post small blind')
              AND player_id = '${escapedId}'
            GROUP BY hand_id, street
          ) sub
          GROUP BY hand_id
        ),
        total_tracked_per_hand AS (
          SELECT hand_id, SUM(street_max) AS total_tracked
          FROM (
            SELECT hand_id, player_id, street, MAX(COALESCE(amount, 0)) AS street_max
            FROM pn_actions
            WHERE action IN ('calls','bets','raise','post big blind','post small blind')
              AND player_id IS NOT NULL
            GROUP BY hand_id, player_id, street
          ) s
          GROUP BY hand_id
        ),
        pot_per_hand AS (
          SELECT hand_id, SUM(hand_max) AS pot, COUNT(*) AS winner_count
          FROM (
            SELECT hand_id, player_id, MAX(amount) AS hand_max
            FROM pn_actions WHERE action = 'collected' AND player_id IS NOT NULL
            GROUP BY hand_id, player_id
          ) sub
          GROUP BY hand_id
        ),
        my_collected AS (
          SELECT hand_id, MAX(amount) AS collected
          FROM pn_actions WHERE action = 'collected' AND player_id = '${escapedId}'
          GROUP BY hand_id
        ),
        hand_costs AS (
          SELECT ht.hand_id,
                 CASE
                   WHEN p.winner_count = 1 AND mc.collected IS NOT NULL THEN
                     GREATEST(0, ht.tracked_cost - GREATEST(0, t.total_tracked - p.pot))
                   ELSE ht.tracked_cost
                 END AS hand_cost
          FROM hand_tracked ht
          JOIN  total_tracked_per_hand t  ON t.hand_id  = ht.hand_id
          LEFT JOIN pot_per_hand       p  ON p.hand_id  = ht.hand_id
          LEFT JOIN my_collected       mc ON mc.hand_id = ht.hand_id
        ),
        hand_collected AS (
          SELECT hand_id, MAX(amount) AS hand_collected
          FROM pn_actions
          WHERE action = 'collected' AND player_id = '${escapedId}'
          GROUP BY hand_id
        ),
        all_hands AS (
          SELECT
            COALESCE(hc.hand_id, hco.hand_id) AS hand_id,
            MIN(ts) AS hand_ts,
            COALESCE(hco.hand_collected, 0) - COALESCE(hc.hand_cost, 0) AS hand_net
          FROM pn_actions a
          LEFT JOIN hand_costs    hc  ON hc.hand_id  = a.hand_id
          LEFT JOIN hand_collected hco ON hco.hand_id = a.hand_id
          WHERE a.player_id = '${escapedId}'
          GROUP BY COALESCE(hc.hand_id, hco.hand_id), hco.hand_collected, hc.hand_cost
        ),
        ordered AS (
          SELECT ROW_NUMBER() OVER (ORDER BY hand_ts) AS hand_order, hand_net
          FROM all_hands
        )
      SELECT
        hand_order::int,
        ROUND(SUM(hand_net) OVER (ORDER BY hand_order)::numeric, 2)::float AS cumulative_profit
      FROM ordered
      ORDER BY hand_order
    `),

    sql<{ hand_id: string; cards_shown: string; pot_collected: number | null }>(`
      SELECT
        s.hand_id,
        SUBSTRING(s.action FROM 7) AS cards_shown,
        w.hand_max                 AS pot_collected
      FROM pn_actions s
      LEFT JOIN (
        SELECT hand_id, player_id, MAX(amount) AS hand_max
        FROM pn_actions WHERE action = 'collected'
        GROUP BY hand_id, player_id
      ) w ON w.hand_id = s.hand_id AND w.player_id = s.player_id
      WHERE s.player_id = '${escapedId}'
        AND s.action LIKE 'shows%'
      ORDER BY s.ts DESC
      LIMIT 50
    `),

    sql<{ action: string; count: number }>(`
      SELECT
        CASE
          WHEN action = 'folds'            THEN 'Fold'
          WHEN action = 'checks'           THEN 'Check'
          WHEN action = 'calls'            THEN 'Call'
          WHEN action IN ('bets','raise')  THEN 'Bet/Raise'
          WHEN action = 'collected'        THEN 'Collected'
          WHEN action LIKE 'post%'         THEN 'Blind'
          WHEN action LIKE 'shows%'        THEN 'Showdown'
          ELSE 'Other'
        END AS action,
        COUNT(*)::int AS count
      FROM pn_actions
      WHERE player_id = '${escapedId}'
      GROUP BY 1
      ORDER BY count DESC
    `),

    sql<{ median_bb: number }>(`
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY amount) AS median_bb
      FROM pn_actions
      WHERE action = 'post big blind' AND amount IS NOT NULL AND amount > 0
    `),
  ]);

  if (!statsRows.length) {
    jsonErr(res, 404, 'Player not found');
    return;
  }

  const medianBB = medianBBRows[0]?.median_bb ?? 1;

  const profile: PlayerProfile = {
    ...statsRows[0],
    median_bb: medianBB,
    profit_trend: trendRows as ProfitPoint[],
    showdown_history: showdownRows as ShowdownEntry[],
    action_breakdown: breakdownRows,
  };

  jsonOk(res, profile);
}

async function handleGame(
  _req: IncomingMessage,
  res: ServerResponse,
  gameId: string,
  logger: Logger
): Promise<void> {
  if (!/^pgl[A-Za-z0-9_-]{10,}$/.test(gameId)) {
    jsonErr(res, 400, 'Invalid game_id format. Expected pgl... format.');
    return;
  }

  let maxHand = 0;
  try {
    const gameRows = await sql<{ max_hand: number }>(`
      SELECT max_hand FROM poker_games WHERE game_id = '${gameId.replace(/'/g, "''")}'  
    `);
    if (gameRows.length) maxHand = gameRows[0].max_hand;
  } catch {
    // table may not exist or query failed
  }

  const httpClient = new HttpClient(logger);

  if (maxHand === 0) {
    try {
      const check = await httpClient.getLogs(gameId, 1);
      if (check.status === 401 || check.status === 403) {
        jsonErr(res, 401, 'Authentication required for this game');
        return;
      }
      if (check.status !== 200 || !check.data?.length) {
        jsonErr(res, 404, 'Game not found or no hands available');
        return;
      }
      const countRows = await sql<{ max_hand: number }>(`
        SELECT COALESCE(MAX(CAST(SUBSTRING(hand_id, 1, 8) AS bigint)), 0) AS max_hand
        FROM pn_actions LIMIT 1
      `).catch(() => [{ max_hand: 100 }]);
      maxHand = Math.max(50, (countRows[0]?.max_hand as unknown as number) || 100);
    } catch {
      jsonErr(res, 503, 'Could not reach PokerNow');
      return;
    }
  }

  const handNumbers = [maxHand, maxHand-1, maxHand-2, maxHand-3, maxHand-4].filter(n => n > 0);
  const responses = await Promise.all(
    handNumbers.map(n => httpClient.getLogs(gameId, n))
  );

  const authErr = responses.find(r => r.status === 401 || r.status === 403);
  if (authErr) {
    jsonErr(res, 401, 'Authentication required for this game');
    return;
  }

  const playerMap = new Map<string, string>();

  for (const response of responses) {
    if (response.status !== 200 || !response.data) continue;

    for (const line of response.data) {
      const stacksMatch = line.msg.match(PLAYER_STACKS_REGEX);
      if (!stacksMatch) continue;

      PLAYER_STACK_ENTRY_REGEX.lastIndex = 0;
      let entryMatch: RegExpExecArray | null;
      while ((entryMatch = PLAYER_STACK_ENTRY_REGEX.exec(stacksMatch[1])) !== null) {
        playerMap.set(entryMatch[3], entryMatch[2]);
      }
    }
  }

  if (playerMap.size === 0) {
    jsonErr(res, 404, 'Game not found or no recent hands available');
    return;
  }

  const idList = Array.from(playerMap.keys())
    .map(id => `'${id.replace(/'/g, "''")}'`)
    .join(',');

  const [knownStats, bbRows] = await Promise.all([
    sql<PlayerSummary>(playersCTE(`WHERE b.player_id IN (${idList})`)),
    fetchMedianBB(),
  ]);

  const statsById = new Map(knownStats.map(s => [s.player_id, s]));

  const known: ScoutPlayer[] = [];
  const unknown: ScoutPlayer[] = [];

  for (const [playerId, display] of playerMap) {
    const stats = statsById.get(playerId) ?? null;
    const entry: ScoutPlayer = { player_id: playerId, player_display: display, is_known: stats !== null, stats };
    if (stats) known.push(entry);
    else unknown.push(entry);
  }

  known.sort((a, b) => (b.stats?.hands_played ?? 0) - (a.stats?.hands_played ?? 0));

  jsonOk(res, {
    game_id: gameId,
    max_hand: maxHand,
    median_bb: bbRows,
    players: [...known, ...unknown],
  });
}

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger
): Promise<boolean> {
  const pathname = getPath(req);

  if (!pathname.startsWith('/api/')) return false;

  try {
    if (pathname === '/api/overview')      { await handleOverview(res);  return true; }
    if (pathname === '/api/stats/funnel')  { await handleFunnel(res);    return true; }
    if (pathname === '/api/stats/pots')    { await handlePots(res);      return true; }
    if (pathname === '/api/stats/actions') { await handleActions(res);   return true; }
    if (pathname === '/api/players')       { await handlePlayers(res);   return true; }

    const playerMatch = pathname.match(/^\/api\/player\/([^/]+)$/);
    if (playerMatch) { await handlePlayer(res, playerMatch[1]); return true; }

    const gameMatch = pathname.match(/^\/api\/game\/([^/]+)$/);
    if (gameMatch)   { await handleGame(req, res, gameMatch[1], logger); return true; }

    jsonErr(res, 404, 'API endpoint not found');
    return true;

  } catch (err) {
    logger.error({ err, pathname }, 'API handler error');
    jsonErr(res, 500, 'Server error — see console');
    return true;
  }
}
