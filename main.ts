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
//     end, almost all of it in two pushes, with a 2% peak-to-trough dip.
//     On it the kit's churn-prone baselines bleed fees (ema-cross makes
//     76 trades and loses 11%), and a bot that waits for a very strong
//     signal before its first entry spends the pushes in cash. So this
//     bot asks for confirmation, not strength: the trailing 60-bar return
//     at +0.15% or more, the last 15 bars not fading, and the close above
//     its 120-bar EMA. That is enough to be long for the pushes and flat
//     for the rest.
//   - Exits are deliberately hard to trigger, because a round trip costs
//     about 26 bps at full size and every shaken-out re-entry pays it
//     again: out only when the close breaks under the EMA by more than
//     0.40% with the trailing hour negative, when the position is worth
//     96.5% of its cost, or when equity draws 6% down from its peak —
//     that last one also parks the bot in cash for 240 bars. There is no
//     take-profit and no trailing stop: a real push is left to run.
//   - Size is 92% of equity, and never more than 0.1% of the pool depth
//     the latest bar's close reported (the depth the next open's fill
//     will trade against is a minute younger, so the latest close's is
//     the one to size against): at the depths this pool shows, that cap
//     keeps the bot's own price impact in single-digit basis points.
//   - A 30-bar cooldown after every exit stops immediate re-entry churn.
//
// All state comes from the bars themselves — no clock, no network, no
// files, no randomness — so the same bars always produce the same orders.

import { BPS, runBars, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

const EMA_SPAN = 120;
/** Entry: trailing 60-bar return at or above +0.15%. */
const ENTRY_R60 = 0.0015;
/** Entry: trailing 15-bar return no worse than -0.05%. */
const ENTRY_R15_MIN = -0.0005;
/** Exit: close under the EMA by more than this share, with the hour negative. */
const EXIT_BUFFER = 0.004;
/** Exit: position worth at most this share of its cost. */
const STOP_RATIO = 0.965;
/** Drawdown brake: equity this share under its peak exits and sits out. */
const BRAKE_DD_NUM = 94n;
const BRAKE_BARS = 240;
const COOLDOWN_BARS = 30;
/** Equity share spent on one entry: 92%. */
const STAKE_NUM = 92n;
const STAKE_DEN = 100n;
/** Stake cap: the latest close depth divided by this (0.1% of depth). */
const DEPTH_CAP_DIV = 1000n;
/** Closes kept: far more than the EMA seed and the 60-bar return need. */
const HISTORY = 1500;

const closes: number[] = [];
let ema: number | null = null;
let emaWarm: number[] = [];
/** The latest bar's close depth in quote units, when the bar carried one. */
let lastDepth: bigint | null = null;
let peakEquity: bigint = 0n;
let brakeUntil = -1;
let barsSinceExit = COOLDOWN_BARS + 1;
let prevHeld = false;

function pushClose(c: number): void {
  closes.push(c);
  if (closes.length > HISTORY) closes.shift();
  if (ema !== null) {
    ema += (2 / (EMA_SPAN + 1)) * (c - ema);
  } else {
    emaWarm.push(c);
    if (emaWarm.length === EMA_SPAN) {
      ema = emaWarm.reduce((a, x) => a + x, 0) / EMA_SPAN;
      emaWarm = [];
    }
  }
}

/** The return over the last `barsBack` closes, or null before enough bars. */
function ret(barsBack: number): number | null {
  if (closes.length <= barsBack) return null;
  return closes[closes.length - 1]! / closes[closes.length - 1 - barsBack]! - 1;
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
      } else if (ema !== null && close < ema * (1 - EXIT_BUFFER)) {
        const r60 = ret(60);
        if (r60 !== null && r60 < 0) exit = true;
      }
      if (exit) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // ---- entry ----
    if (state.seq < brakeUntil) return [];
    if (barsSinceExit <= COOLDOWN_BARS) return [];
    const r60 = ret(60);
    const r15 = ret(15);
    if (r60 === null || r60 < ENTRY_R60) return [];
    if (r15 === null || r15 < ENTRY_R15_MIN) return [];
    if (ema === null || close <= ema) return [];

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
