export interface LogLine {
  msg: string;
  createdAt: string;
}

export interface Hand {
  hand_id: string;
  room_id: string;
  hand_number: number;
  started_at: Date;
  ended_at: Date;
  sb: number | null;
  bb: number | null;
  variant: string | null;
  dealer: string | null;
  board: string[] | null;
  raw: LogLine[];
}

export interface Action {
  hand_id: string;
  idx: number;
  player_display: string | null;
  player_id: string | null;
  street: string | null;
  action: string;
  amount: number | null;
  ts: Date;
}

export interface HandPlayer {
  hand_id: string;
  player_id: string;
  player_display: string | null;
  seat: number | null;
  starting_stack: number | null;
  ending_stack: number | null;
  won: number | null;
}

export interface ParsedHand {
  complete: boolean;
  hand?: Hand;
  actions?: Action[];
  players?: HandPlayer[];
}

export interface RateLimitConfig {
  minDelayMs: number;
  maxDelayMs: number;
  jitterFactor: number;
}

export interface HttpResponse {
  status: number;
  data: LogLine[] | null;
  error?: string;
}

export interface PlayerSummary {
  player_id: string;
  player_display: string;
  hands_played: number;
  vpip_pct: number;
  pfr_pct: number;
  aggression_pct: number;
  showdown_pct: number;
  net_profit: number;
  style_label: 'TAG' | 'LAG' | 'LAP' | 'Passive';
}

export interface ProfitPoint {
  hand_order: number;
  cumulative_profit: number;
}

export interface ShowdownEntry {
  hand_id: string;
  cards_shown: string;
  pot_collected: number | null;
}

export interface PlayerProfile extends PlayerSummary {
  median_bb: number;
  profit_trend: ProfitPoint[];
  showdown_history: ShowdownEntry[];
  action_breakdown: Array<{ action: string; count: number }>;
}

export interface ScoutPlayer {
  player_id: string;
  player_display: string;
  is_known: boolean;
  stats: PlayerSummary | null;
}
