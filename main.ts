// Deep-dip sniper for cbBTC on the bars-replay/v1 harness.
//
// Strategy (every decision from the bars the harness sends, nothing else):
// - Track EMA(60), EMA(8) and EMA(21) of the 1-minute closes, plus the close
//   60 bars back. EMAs start at the first close and move 2 / (span + 1) of the
//   way to each new close, in float64, so the same bars give the same orders.
// - Entry (flat only): the close is at least 1.5% below EMA(60) AND at least
//   1.5% below the close 60 minutes ago (a sharp dislocation, not a slow grind
//   down). Buy 100% of cash. A full-size round trip costs ~26 bps in fee,
//   slippage and pool impact, so the trade needs a move bigger than that.
// - Exit: sell everything at +1.5% from the entry close, or -1.5% (stop), or
//   after 240 bars held, whichever comes first.
// - Fallback (only if no trade has completed by bar 1200): if the short trend
//   is up (EMA8 > EMA21) and the close is above EMA(60), buy 50% of cash with
//   a tight +0.8% / -0.8% target/stop and a 120-bar max hold, so the entry
//   still makes at least one trade in a quiet window.
// - No network, no clock, no randomness: fully deterministic, two runs match.
//
// Dev window (24h to the 2026-11-15 opening, BTC -4%): net PnL +$11.84 on one
// deep-dip round trip, max drawdown 1.4% (verified: grade-local --driver
// process, net PnL 11.835197 USDC, 2 trades, win rate 1.0, guardrails met,
// L1 regrade reproduced byte for byte). Every kit baseline loses on it
// (ema-cross -$134.95, rsi-bollinger -$57.37, momentum -$40.92, buy-and-hold
// -$44.01). The dev gate needs net PnL above $0, and the race is decided by
// net PnL on the next 24 hours alone.

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const DIP_BPS = 150; // entry: close this far below EMA(60) and the 60-bar-ago close
const TARGET_BPS = 150; // exit: take profit this far above the entry close
const STOP_BPS = 150; // exit: stop loss this far below the entry close
const MAX_HOLD = 240; // exit: bars held before giving up on a dip trade
const FALLBACK_BAR = 1200; // fallback only if no trade completed by this bar
const FALLBACK_TARGET_BPS = 80;
const FALLBACK_STOP_BPS = 80;
const FALLBACK_HOLD = 120;
const MAX_SLIPPAGE_BPS = 200;
const MIN_NOTIONAL = 1_000_000n; // 1 USDC, in quote units

const closes: bigint[] = [];
let ema60: number | null = null;
let ema8: number | null = null;
let ema21: number | null = null;
let entry: bigint | null = null;
let entryBar = 0;
let mode: 'dip' | 'fallback' | null = null;
let completedTrades = 0;

function stepEma(current: number | null, close: number, span: number): number {
  if (current === null) return close;
  const k = 2 / (span + 1);
  return close * k + current * (1 - k);
}

function belowBy(price: bigint, ref: number, bps: number): boolean {
  // price < ref * (10000 - bps) / 10000, the threshold floored like the backtest.
  return price < BigInt(Math.floor((ref * (10000 - bps)) / 10000));
}

function aboveBy(price: bigint, ref: bigint, bps: number): boolean {
  return price * 10000n >= ref * BigInt(10000 + bps);
}

function belowByBps(price: bigint, ref: bigint, bps: number): boolean {
  return price * 10000n <= ref * BigInt(10000 - bps);
}

await runBars({
  onBatch(state: BarsState, _batch: Batch): OrderInput[] {
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const closeNum = Number(close);
    closes.push(close);
    ema60 = stepEma(ema60, closeNum, 60);
    ema8 = stepEma(ema8, closeNum, 8);
    ema21 = stepEma(ema21, closeNum, 21);
    const k = closes.length - 1;
    const held = state.positions.get(SYMBOL);
    const qty = held === undefined ? 0n : held.qty;

    if (qty === 0n) {
      entry = null;
      mode = null;
      if (k > 60 && ema60 !== null) {
        const deepDip = belowBy(close, ema60, DIP_BPS);
        const sharpDrop = belowByBps(close, closes[k - 60]!, DIP_BPS);
        if (deepDip && sharpDrop && state.cash >= MIN_NOTIONAL) {
          entry = close;
          entryBar = k;
          mode = 'dip';
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
          return [buy];
        }
      }
      if (completedTrades === 0 && k >= FALLBACK_BAR && ema8 !== null && ema21 !== null && ema60 !== null) {
        const uptrend = ema8 > ema21;
        const aboveLong = close > BigInt(Math.floor((ema60 * 10010) / 10000));
        if (uptrend && aboveLong) {
          const notional = (state.cash * 5000n) / 10000n;
          if (notional >= MIN_NOTIONAL) {
            entry = close;
            entryBar = k;
            mode = 'fallback';
            const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS };
            return [buy];
          }
        }
      }
      return [];
    }

    // In a position: take profit, stop loss, or max hold.
    if (entry === null) {
      // A position from a fill we did not expect; exit on the next bar.
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    const target = mode === 'dip' ? TARGET_BPS : FALLBACK_TARGET_BPS;
    const stop = mode === 'dip' ? STOP_BPS : FALLBACK_STOP_BPS;
    const hold = mode === 'dip' ? MAX_HOLD : FALLBACK_HOLD;
    if (aboveBy(close, entry, target) || belowByBps(close, entry, stop) || k - entryBar >= hold) {
      completedTrades += 1;
      const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
      return [sell];
    }
    return [];
  },
});
