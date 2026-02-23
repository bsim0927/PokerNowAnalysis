import type { Logger } from 'pino';
import type { LogLine, ParsedHand, Hand, Action, HandPlayer } from './types.js';
import { microsToDate, parseNumeric, parseCards, deriveHandId } from './util.js';

const START_SENTINEL_REGEX = /^-- starting hand #(\d+) \(id: ([a-z0-9]+)\)\s+(.+?)\s+\(dealer:\s*"([^"]+)"\s*\) --$/;
const END_SENTINEL_REGEX = /^-- ending hand #(\d+) --$/;
export const PLAYER_STACKS_REGEX = /^Player stacks:\s*(.+)$/;
export const PLAYER_STACK_ENTRY_REGEX = /#(\d+)\s+"(.+?)\s+@\s+([A-Za-z0-9_-]+)"\s+\(([\d.]+)\)/g;
const BLIND_REGEX = /^"(.+?)\s+@\s+([A-Za-z0-9_-]+)" posts a (small|big) blind of ([\d.]+)$/;
const ACTION_REGEX = /^"(.+?)\s+@\s+([A-Za-z0-9_-]+)"\s+(checks|calls|bets|raises to|folds|raises)(?:\s+([\d.]+))?/;
const UNCALLED_BET_REGEX = /^Uncalled bet of ([\d.]+) returned to "(.+?)\s+@\s+([A-Za-z0-9_-]+)"/;
const FLOP_REGEX = /^Flop:\s*(.+)$/;
const TURN_REGEX = /^Turn:\s*(.+)$/;
const RIVER_REGEX = /^River:\s*(.+)$/;
const SHOWDOWN_REGEX = /^"(.+?)\s+@\s+([A-Za-z0-9_-]+)" shows a (.+?)\.$/;
const WINNER_REGEX = /^"(.+?)\s+@\s+([A-Za-z0-9_-]+)" collected ([\d.]+) from pot(?: with (.+))?/;

export class LogParser {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger.child({ component: 'parser' });
  }

  parseHand(roomId: string, handNumber: number, logLines: LogLine[]): ParsedHand {
    // Sort by createdAt ascending
    const sorted = [...logLines].sort((a, b) => {
      const aTime = BigInt(a.createdAt);
      const bTime = BigInt(b.createdAt);
      return aTime < bTime ? -1 : aTime > bTime ? 1 : 0;
    });

    // Find sentinels
    let startIdx = -1;
    let endIdx = -1;
    let handId: string | null = null;
    let variant: string | null = null;
    let dealer: string | null = null;

    for (let i = 0; i < sorted.length; i++) {
      const msg = sorted[i].msg;

      // Check for start sentinel
      const startMatch = msg.match(START_SENTINEL_REGEX);
      if (startMatch) {
        const hn = parseInt(startMatch[1], 10);
        if (hn === handNumber) {
          startIdx = i;
          handId = startMatch[2];
          variant = startMatch[3] || null;
          dealer = startMatch[4] || null;
        }
      }

      // Check for end sentinel
      const endMatch = msg.match(END_SENTINEL_REGEX);
      if (endMatch) {
        const hn = parseInt(endMatch[1], 10);
        if (hn === handNumber) {
          endIdx = i;
        }
      }
    }

    // Hand must be complete
    if (startIdx === -1 || endIdx === -1 || !handId) {
      this.logger.debug({
        roomId,
        handNumber,
        startIdx,
        endIdx,
        handId
      }, 'Incomplete hand - missing sentinels');

      return { complete: false };
    }

    // Derive hand_id if not found
    if (!handId) {
      handId = deriveHandId(roomId, handNumber, sorted[startIdx].createdAt);
    }

    // Extract hand data
    const handLines = sorted.slice(startIdx, endIdx + 1);

    const players: HandPlayer[] = [];
    const actions: Action[] = [];
    const board: string[] = [];
    let sb: number | null = null;
    let bb: number | null = null;
    let currentStreet: string | null = null;
    let actionIdx = 0;

    // Player stacks map for tracking
    const playerStacks = new Map<string, { seat: number; startStack: number; display: string }>();
    const playerWinnings = new Map<string, number>();

    for (const line of handLines) {
      const msg = line.msg;
      const ts = microsToDate(line.createdAt);

      // Player stacks
      const stacksMatch = msg.match(PLAYER_STACKS_REGEX);
      if (stacksMatch) {
        const stacksStr = stacksMatch[1];
        let entryMatch: RegExpExecArray | null;

        while ((entryMatch = PLAYER_STACK_ENTRY_REGEX.exec(stacksStr)) !== null) {
          const seat = parseInt(entryMatch[1], 10);
          const playerDisplay = entryMatch[2];
          const playerId = entryMatch[3];
          const stack = parseFloat(entryMatch[4]);

          playerStacks.set(playerId, {
            seat,
            startStack: stack,
            display: playerDisplay
          });
        }
        continue;
      }

      // Blinds
      const blindMatch = msg.match(BLIND_REGEX);
      if (blindMatch) {
        const playerDisplay = blindMatch[1];
        const playerId = blindMatch[2];
        const blindType = blindMatch[3];
        const amount = parseFloat(blindMatch[4]);

        if (blindType === 'small') {
          sb = amount;
        } else if (blindType === 'big') {
          bb = amount;
        }

        actions.push({
          hand_id: handId!,
          idx: actionIdx++,
          player_display: playerDisplay,
          player_id: playerId,
          street: 'preflop',
          action: `post ${blindType} blind`,
          amount,
          ts
        });
        continue;
      }

      // Streets
      if (msg.match(FLOP_REGEX)) {
        currentStreet = 'flop';
        const flopMatch = msg.match(FLOP_REGEX);
        if (flopMatch) {
          const cards = parseCards(flopMatch[1]);
          board.push(...cards);
        }
        continue;
      }

      if (msg.match(TURN_REGEX)) {
        currentStreet = 'turn';
        const turnMatch = msg.match(TURN_REGEX);
        if (turnMatch) {
          const cards = parseCards(turnMatch[1]);
          board.push(...cards);
        }
        continue;
      }

      if (msg.match(RIVER_REGEX)) {
        currentStreet = 'river';
        const riverMatch = msg.match(RIVER_REGEX);
        if (riverMatch) {
          const cards = parseCards(riverMatch[1]);
          board.push(...cards);
        }
        continue;
      }

      // Uncalled bet returned
      const uncalledMatch = msg.match(UNCALLED_BET_REGEX);
      if (uncalledMatch) {
        const amount = parseFloat(uncalledMatch[1]);
        const playerDisplay = uncalledMatch[2];
        const playerId = uncalledMatch[3];
        actions.push({
          hand_id: handId!,
          idx: actionIdx++,
          player_display: playerDisplay,
          player_id: playerId,
          street: currentStreet || 'preflop',
          action: 'uncalled_bet_returned',
          amount,
          ts
        });
        continue;
      }

      // Actions
      const actionMatch = msg.match(ACTION_REGEX);
      if (actionMatch) {
        const playerDisplay = actionMatch[1];
        const playerId = actionMatch[2];
        let actionType = actionMatch[3];
        const amountStr = actionMatch[4];

        let amount: number | null = null;
        if (amountStr) {
          amount = parseNumeric(amountStr);
        }

        if (actionType === 'raises to' || actionType === 'raises') {
          actionType = 'raise';
        }

        actions.push({
          hand_id: handId!,
          idx: actionIdx++,
          player_display: playerDisplay,
          player_id: playerId,
          street: currentStreet || 'preflop',
          action: actionType,
          amount,
          ts
        });
        continue;
      }

      // Showdown
      const showdownMatch = msg.match(SHOWDOWN_REGEX);
      if (showdownMatch) {
        const playerDisplay = showdownMatch[1];
        const playerId = showdownMatch[2];
        const handRank = showdownMatch[3];

        actions.push({
          hand_id: handId!,
          idx: actionIdx++,
          player_display: playerDisplay,
          player_id: playerId,
          street: 'showdown',
          action: `shows ${handRank}`,
          amount: null,
          ts
        });
        continue;
      }

      // Winner
      const winnerMatch = msg.match(WINNER_REGEX);
      if (winnerMatch) {
        const playerDisplay = winnerMatch[1];
        const playerId = winnerMatch[2];
        const amount = parseFloat(winnerMatch[3]);

        playerWinnings.set(playerId, (playerWinnings.get(playerId) || 0) + amount);

        actions.push({
          hand_id: handId!,
          idx: actionIdx++,
          player_display: playerDisplay,
          player_id: playerId,
          street: 'showdown',
          action: 'collected',
          amount,
          ts
        });
        continue;
      }
    }

    // Build players array
    for (const [playerId, info] of playerStacks) {
      const won = playerWinnings.get(playerId) || null;

      players.push({
        hand_id: handId!,
        player_id: playerId,
        player_display: info.display,
        seat: info.seat,
        starting_stack: info.startStack,
        ending_stack: null,
        won
      });
    }

    const hand: Hand = {
      hand_id: handId!,
      room_id: roomId,
      hand_number: handNumber,
      started_at: microsToDate(sorted[startIdx].createdAt),
      ended_at: microsToDate(sorted[endIdx].createdAt),
      sb,
      bb,
      variant,
      dealer,
      board: board.length > 0 ? board : null,
      raw: sorted
    };

    this.logger.debug({
      handId: hand.hand_id,
      handNumber,
      playerCount: players.length,
      actionCount: actions.length
    }, 'Hand parsed successfully');

    return {
      complete: true,
      hand,
      actions,
      players
    };
  }
}
