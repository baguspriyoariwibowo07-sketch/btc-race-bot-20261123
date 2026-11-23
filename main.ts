// Trend Rider — a long-only CBBTC trend bot for 1-minute bars.
//
// Built for the make.fun 24-hour BTC race (agent-fun/bars-replay/v1). The
// shape of the bot follows the kit's own baselines: it speaks through the
// vendored SDK shim, reads the account from the batch state, sends sells
// before buys, stakes the smallest of an equity share, the weight cap and
// the cash on hand, and caps every order's slippage 100 bps past the close
// it was decided on. The strategy itself is written for this race:
//
//   - The dev window this kit ships is a grind, not a trend: +3.6% end to
//     end, almost all of it in two pushes, then 900 bars of sideways chop
//     between 60.5k and 61k. On it the kit's churn-prone baselines bleed
//     fees (ema-cross makes 76 trades and loses 11%), and a first version
//     of this bot that entered on a merely positive trailing hour kept
//     re-entering the chop and paying the ~26 bps round trip each time.
//     So an entry now needs the trend to be demonstrably under way, not
//     just positive: the trailing 60-bar return at +0.20% or more, the
//     close above its 120-bar EMA, that EMA itself up at least 0.08%
//     over the last 60 bars, and the close within 0.1% of the highest
//     close of the last 60 bars — a breakout, not a bounce. In a flat
//     band the EMA is flat and the close is mid-range, so the bot stays
//     in cash; in a real push all four line up early and stay lined up.
//   - Exits are read off a slower line than entries, a 240-bar EMA, and
//     are deliberately hard to trigger, because every shaken-out
//     re-entry pays the round trip again: out only when the close breaks
//     under the 240-bar EMA by more than 0.50% with the trailing two
//     hours negative, when the position is worth 96.5% of its cost, or
//     when equity draws 6% down from its peak — that last one also parks
//     the bot in cash for 240 bars. There is no take-profit and no
//     trailing stop: a real push is left to run.
//   - Size is 92% of equity, and never more than 0.1% of the pool depth
//     the latest bar's close reported (the depth the next open's fill
//     will trade against is a minute younger, so the latest close's is
//     the one to size against): at the depths this pool shows, that cap
//     keeps the bot's own price impact in single-digit basis points.
//   - A 45-bar cooldown after every exit stops immediate re-entry churn.
//     After a losing exit the bot turns cautious: the cooldown stretches
//     to 90 bars and re-entry demands a strict new 240-bar high, because
//     losses cluster in chop while a trend's first entry usually wins —
//     caution costs little in a trend and bleeds far less in a range.
//
// All state comes from the bars themselves — no clock, no network, no
// files, no randomness — so the same bars always produce the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

const EMA_FAST = 120;
const EMA_SLOW = 240;
/** Entry: trailing 60-bar return at or above +0.20%. */
const ENTRY_R60 = 0.002;
/** Entry: the fast EMA up at least this share over the last 60 bars. */
const ENTRY_SLOPE = 0.0008;
/** Entry: close at least this share of the last 60 bars' highest close. */
const ENTRY_NEAR_HIGH = 0.999;
/** Exit: close under the slow EMA by more than this share, two hours negative. */
const EXIT_BUFFER = 0.005;
/** Exit: position worth at most this share of its cost. */
const STOP_RATIO = 0.965;
/** Drawdown brake: equity under 94% of its peak exits and sits out. */
const BRAKE_DD_NUM = 94n;
const BRAKE_BARS = 240;
const COOLDOWN_BARS = 45;
/** Cooldown after a losing exit, while the bot is cautious. */
const CAUTIOUS_COOLDOWN_BARS = 90;
/** Equity share spent on one entry: 92%. */
const STAKE_NUM = 92n;
const STAKE_DEN = 100n;
/** Stake cap: the latest close depth divided by this (0.1% of depth). */
const DEPTH_CAP_DIV = 1000n;
/** Closes kept: far more than the EMA seeds and the returns need. */
const HISTORY = 1500;

const closes: number[] = [];
/** The fast EMA's value on each bar since it seeded, oldest first. */
const emaTrail: number[] = [];
let emaFast: number | null = null;
let emaFastWarm: number[] = [];
let emaSlow: number | null = null;
let emaSlowWarm: number[] = [];
/** The latest bar's close depth in quote units, when the bar carried one. */
let lastDepth: bigint | null = null;
let peakEquity: bigint = 0n;
let brakeUntil = -1;
let barsSinceExit = COOLDOWN_BARS + 1;
let prevHeld = false;
/** True after a losing exit, until a winning exit clears it. */
let cautious = false;

function pushEma(span: number, warm: number[], current: number | null, c: number): { ema: number | null; warm: number[] } {
  if (current !== null) return { ema: current + (2 / (span + 1)) * (c - current), warm };
  warm.push(c);
  if (warm.length === span) return { ema: warm.reduce((a, x) => a + x, 0) / span, warm: [] };
  return { ema: null, warm };
}

function pushClose(c: number): void {
  closes.push(c);
  if (closes.length > HISTORY) closes.shift();
  const f = pushEma(EMA_FAST, emaFastWarm, emaFast, c);
  emaFast = f.ema;
  emaFastWarm = f.warm;
  const s = pushEma(EMA_SLOW, emaSlowWarm, emaSlow, c);
  emaSlow = s.ema;
  emaSlowWarm = s.warm;
  if (emaFast !== null) {
    emaTrail.push(emaFast);
    if (emaTrail.length > HISTORY) emaTrail.shift();
  }
}

/** The return over the last `barsBack` closes, or null before enough bars. */
function ret(barsBack: number): number | null {
  if (closes.length <= barsBack) return null;
  return closes[closes.length - 1]! / closes[closes.length - 1 - barsBack]! - 1;
}

/** The highest close of the last `barsBack` closes before this one, or null. */
function recentHigh(barsBack: number): number | null {
  if (closes.length <= barsBack) return null;
  let hi = 0;
  for (let i = closes.length - 1 - barsBack; i < closes.length - 1; i++) {
    if (closes[i]! > hi) hi = closes[i]!;
  }
  return hi;
}

await runBars({
  onBatch(state, batch) {
    let bar;
    for (const b of batch.bars) if (b.symbol === SYMBOL) bar = b;
    if (bar === undefined) return [];
    const close = Number(bar.c);
    pushClose(close);
    if (bar.c_depth.length > 0) lastDepth = BigInt(bar.c_depth[0]!);

    if (state.equity > peakEquity) peakEquity = state.equity;

    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      if (prevHeld) barsSinceExit = 0;
      else barsSinceExit++;
      prevHeld = false;
    }

    if (state.warmingUp) return [];

    // ---- exit ----
    if (held !== undefined) {
      prevHeld = true;
      const value = state.value(SYMBOL, held.qty);
      const ratio = Number((value * 1000000n) / held.cost) / 1000000;
      let exit = false;
      if (ratio <= STOP_RATIO) {
        exit = true;
      } else if (peakEquity > 0n && state.equity * 100n < peakEquity * BRAKE_DD_NUM) {
        exit = true;
        brakeUntil = state.seq + BRAKE_BARS;
      } else if (emaSlow !== null && close < emaSlow * (1 - EXIT_BUFFER)) {
        const r120 = ret(120);
        if (r120 !== null && r120 < 0) exit = true;
      }
      if (exit) {
        cautious = ratio < 1;
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // ---- entry ----
    if (state.seq < brakeUntil) return [];
    if (barsSinceExit <= (cautious ? CAUTIOUS_COOLDOWN_BARS : COOLDOWN_BARS)) return [];
    const r60 = ret(60);
    if (r60 === null || r60 < ENTRY_R60) return [];
    if (emaFast === null || close <= emaFast) return [];
    if (emaTrail.length <= 60) return [];
    const slope = emaTrail[emaTrail.length - 1]! / emaTrail[emaTrail.length - 1 - 60]! - 1;
    if (slope < ENTRY_SLOPE) return [];
    const hi = recentHigh(60);
    if (hi === null || close < hi * ENTRY_NEAR_HIGH) return [];
    if (cautious) {
      const hi240 = recentHigh(240);
      if (hi240 === null || close <= hi240) return [];
    }

    const { caps, fees } = state.hello;
    if (state.positions.size >= caps.max_open_positions) return [];
    let stake = (state.equity * STAKE_NUM) / STAKE_DEN;
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    if (byWeight < stake) stake = byWeight;
    if (lastDepth !== null) {
      const depthCap = lastDepth / DEPTH_CAP_DIV;
      if (depthCap < stake) stake = depthCap;
    }
    if (state.cash < stake) stake = state.cash;
    if (stake === 0n || stake < BigInt(fees.min_notional_quote_units)) return [];
    const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});
