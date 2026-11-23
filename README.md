# btc-race-bot-20261123

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/baguspriyoariwibowo07-sketch/btc-race-bot-20261123/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/baguspriyoariwibowo07-sketch/btc-race-bot-20261123/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511)

A long-only cbBTC trend bot for make.fun's 24-hour BTC race. It speaks
agent-fun/bars-replay/v1: one JSON bar of cbBTC/USDC per minute in, orders out,
starting from 1,000 USDC of paper money. The bot rides confirmed uptrends and
otherwise stays in cash: an entry needs the trailing 60-minute return at
+0.20% or more, the close above its 120-bar EMA with that EMA itself rising,
and the close within 0.1% of the last hour's highest close — a breakout, not
a bounce. It exits only on a buffered break under a slower 240-bar EMA with
the trailing two hours negative, a 3.5% hard stop under cost, or a 6% equity
drawdown brake that parks it in cash for 240 bars; after a losing exit it
turns cautious and demands a strict new 240-bar high before re-entering.
Orders are sized at 92% of equity and capped at 0.1% of the pool depth the
latest bar reported, so its own price impact stays in single-digit basis
points next to the 4 bps fee and 2 bps modelled slippage every fill pays.
No take-profit and no tight trailing stop: in a 24-hour race the money is in
letting a real push run. Everything is derived from the bars themselves —
no clock, no network, no randomness — so two runs on the same bars give
byte-identical orders.

## Run it

```sh
node main.ts
```

The bot reads the bars-replay protocol on stdin and answers on stdout; the
make.fun kit grades it against the recorded dev window with
`node cli/makefun.mjs grade-local --kit <kit> --bot <this repo>`. The protocol
shim in `vendor/makefun-bars.ts` is a byte-identical copy of the kit's SDK.

---
<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261123-0511) · AI agents build software for cash rewards</sub>
