#!/usr/bin/env node
const { PRESETS } = require('../src/strategies');
const { computeStrategySignal } = require('../src/strategy-engine');

function createRng(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function generateSyntheticSeries(length = 25000, seed = 1337, start = 100.0) {
  const rng = createRng(seed);
  const ticks = [];
  const digits = [];
  const candles = [];
  let price = start;
  let candleOpen = start;
  let candleHigh = start;
  let candleLow = start;
  for (let i = 0; i < length; i += 1) {
    const drift = Math.sin(i / 87) * 0.015 + Math.sin(i / 23) * 0.008;
    const shock = gaussian(rng) * 0.09;
    price = Math.max(10, price + drift + shock);
    const rounded = Number(price.toFixed(2));
    ticks.push(rounded);
    digits.push(Math.abs(Math.round(rounded * 100)) % 10);
    candleHigh = Math.max(candleHigh, rounded);
    candleLow = Math.min(candleLow, rounded);
    if ((i + 1) % 5 === 0) {
      candles.push({
        open: candleOpen,
        high: candleHigh,
        low: candleLow,
        close: rounded,
        time: i + 1
      });
      candleOpen = rounded;
      candleHigh = rounded;
      candleLow = rounded;
    }
  }
  return { ticks, digits, candles };
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function payoutRatio(contractType) {
  switch (contractType) {
    case 'CALL':
    case 'PUT':
      return 0.85;
    case 'DIGITOVER':
    case 'DIGITUNDER':
    case 'DIGITEVEN':
    case 'DIGITODD':
      return 0.90;
    case 'DIGITDIFFERS':
      return 0.0965;
    case 'DIGITMATCH':
      return 8.0;
    default:
      return 0.85;
  }
}

function minStakeForMode(mode) {
  return mode === 'digits' ? 0.35 : 0.5;
}

function clampStake(mode, stake) {
  const min = minStakeForMode(mode);
  return Math.max(min, Number.isFinite(stake) ? stake : min);
}

function settleTrade(mode, settings, signal, entryIndex, expiryIndex, data) {
  const entryPrice = data.ticks[entryIndex];
  const exitPrice = data.ticks[expiryIndex];
  const exitDigit = data.digits[expiryIndex];
  const contractType = signal.contractType || settings.tradeType || (signal.direction === 'RISE' ? 'CALL' : signal.direction === 'FALL' ? 'PUT' : 'DIGITEVEN');
  let won = false;
  if (contractType === 'CALL') won = exitPrice > entryPrice;
  else if (contractType === 'PUT') won = exitPrice < entryPrice;
  else if (contractType === 'DIGITOVER') won = exitDigit > Number(signal.barrier ?? settings.barrier ?? 4);
  else if (contractType === 'DIGITUNDER') won = exitDigit < Number(signal.barrier ?? settings.barrier ?? 5);
  else if (contractType === 'DIGITEVEN') won = exitDigit % 2 === 0;
  else if (contractType === 'DIGITODD') won = exitDigit % 2 === 1;
  else if (contractType === 'DIGITDIFFERS') won = exitDigit !== Number(signal.barrier ?? settings.predictedDigit ?? 0);
  else if (contractType === 'DIGITMATCH') won = exitDigit === Number(signal.barrier ?? settings.predictedDigit ?? 8);
  return { won, exitPrice, exitDigit, contractType };
}

function adjustStake(currentStake, settings, result, mode) {
  const stakeMode = settings.stakeMode || 'fixed';
  const baseStake = clampStake(mode, settings.stakeAmount || currentStake);
  if (stakeMode === 'fixed') return baseStake;
  if (stakeMode === 'martingale') {
    return result === 'loss'
      ? clampStake(mode, currentStake * Number(settings.lossMultiplier || 2))
      : baseStake;
  }
  if (stakeMode === 'pls') {
    return result === 'loss'
      ? clampStake(mode, currentStake * Number(settings.lossMultiplier || 1.3))
      : baseStake;
  }
  if (stakeMode === 'anti_martingale') {
    return result === 'win'
      ? clampStake(mode, currentStake * Number(settings.winMultiplier || 1.05))
      : clampStake(mode, currentStake * Number(settings.lossMultiplier || 0.85));
  }
  return baseStake;
}

function runPresetBacktest(mode, preset, settings, data, targetTrades = 500) {
  const localSettings = clone(settings);
  const state = { rotationIndex: 0 };
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let pnl = 0;
  let equity = 1000;
  let peakEquity = equity;
  let maxDrawdown = 0;
  let maxLossStreak = 0;
  let lossStreak = 0;
  let currentStake = clampStake(mode, localSettings.stakeAmount || minStakeForMode(mode));
  let tick = 0;
  let lastTradeTick = -Infinity;
  const cooldownTicks = Math.max(1, Math.ceil(Number(localSettings.cooldownMs || 0) / 500));
  const tradeLog = [];

  while (tick < data.ticks.length - 20 && trades < targetTrades) {
    tick += 1;
    if (tick - lastTradeTick < cooldownTicks) continue;
    const live = {
      ticks: data.ticks.slice(0, tick + 1),
      digits: data.digits.slice(0, tick + 1),
      candles: data.candles.filter((c) => c.time <= tick + 1)
    };
    const signal = computeStrategySignal({ mode, settings: localSettings, ...live, state });
    if (!signal.trade) continue;
    if (signal.nextState && Object.prototype.hasOwnProperty.call(signal.nextState, 'rotationIndex')) {
      state.rotationIndex = signal.nextState.rotationIndex;
    }
    const duration = Number(localSettings.duration || 1);
    const expiryIndex = tick + duration;
    if (expiryIndex >= data.ticks.length) break;
    const settled = settleTrade(mode, localSettings, signal, tick, expiryIndex, data);
    const ratio = payoutRatio(settled.contractType);
    const profit = settled.won ? currentStake * ratio : -currentStake;
    pnl += profit;
    equity += profit;
    peakEquity = Math.max(peakEquity, equity);
    maxDrawdown = Math.max(maxDrawdown, peakEquity - equity);
    trades += 1;
    if (settled.won) {
      wins += 1;
      lossStreak = 0;
    } else {
      losses += 1;
      lossStreak += 1;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    }
    tradeLog.push({
      trade: trades,
      entryTick: tick,
      exitTick: expiryIndex,
      reason: signal.reason,
      contractType: settled.contractType,
      barrier: signal.barrier ?? null,
      stake: Number(currentStake.toFixed(2)),
      result: settled.won ? 'won' : 'lost',
      profit: Number(profit.toFixed(2)),
      equity: Number(equity.toFixed(2)),
      exitDigit: settled.exitDigit
    });
    currentStake = adjustStake(currentStake, localSettings, settled.won ? 'win' : 'loss', mode);
    lastTradeTick = tick;
    tick = expiryIndex;
  }

  const avgWin = wins ? tradeLog.filter((t) => t.result === 'won').reduce((a, b) => a + b.profit, 0) / wins : 0;
  const avgLoss = losses ? Math.abs(tradeLog.filter((t) => t.result === 'lost').reduce((a, b) => a + b.profit, 0) / losses) : 0;
  const winRate = trades ? (wins / trades) * 100 : 0;
  const ev = trades ? pnl / trades : 0;
  return {
    mode,
    preset,
    trades,
    wins,
    losses,
    winRate: Number(winRate.toFixed(2)),
    pnl: Number(pnl.toFixed(2)),
    endingEquity: Number(equity.toFixed(2)),
    avgWin: Number(avgWin.toFixed(2)),
    avgLoss: Number(avgLoss.toFixed(2)),
    evPerTrade: Number(ev.toFixed(4)),
    maxLossStreak,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    firstReason: tradeLog[0]?.reason || 'none',
    sampleContract: tradeLog[0]?.contractType || 'n/a',
    lastStake: Number(currentStake.toFixed(2)),
    tradeLog
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { trades: 500, seed: 1337, ticks: 30000, json: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--trades') out.trades = Number(args[++i] || out.trades);
    else if (arg === '--seed') out.seed = Number(args[++i] || out.seed);
    else if (arg === '--ticks') out.ticks = Number(args[++i] || out.ticks);
    else if (arg === '--json') out.json = true;
  }
  return out;
}

function main() {
  const opts = parseArgs();
  const data = generateSyntheticSeries(opts.ticks, opts.seed);
  const results = [];
  for (const [mode, presets] of Object.entries(PRESETS)) {
    if (mode === 'accumulator') continue;
    for (const [preset, settings] of Object.entries(presets)) {
      results.push(runPresetBacktest(mode, preset, settings, data, opts.trades));
    }
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(results, null, 2));
    return;
  }
  console.table(results.map((r) => ({
    mode: r.mode,
    preset: r.preset,
    trades: r.trades,
    wins: r.wins,
    losses: r.losses,
    winRate: `${r.winRate}%`,
    pnl: r.pnl,
    evPerTrade: r.evPerTrade,
    maxLossStreak: r.maxLossStreak,
    maxDrawdown: r.maxDrawdown,
    firstReason: r.firstReason,
    sampleContract: r.sampleContract
  })));
}

if (require.main === module) main();

module.exports = { generateSyntheticSeries, runPresetBacktest, settleTrade };
