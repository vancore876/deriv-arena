function clampNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function last(arr, n = 1) {
  return n === 1 ? arr[arr.length - 1] : arr.slice(-n);
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 1) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i += 1) out = values[i] * k + out * (1 - k);
  return out;
}

function sma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function wma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  let num = 0;
  let den = 0;
  for (let i = 0; i < slice.length; i += 1) {
    const w = i + 1;
    num += slice[i] * w;
    den += w;
  }
  return den ? num / den : null;
}

function hma(values, period) {
  if (!Array.isArray(values) || values.length < period || period <= 1) return null;
  const half = Math.max(2, Math.floor(period / 2));
  const sqrt = Math.max(2, Math.floor(Math.sqrt(period)));
  const raw = [];
  for (let i = period; i <= values.length; i += 1) {
    const sub = values.slice(0, i);
    const halfWma = wma(sub, half);
    const fullWma = wma(sub, period);
    if (halfWma == null || fullWma == null) continue;
    raw.push(2 * halfWma - fullWma);
  }
  return wma(raw, Math.min(sqrt, raw.length));
}

function bollinger(values, period = 20, stdDev = 2) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / period;
  const deviation = Math.sqrt(variance);
  return { mean, upper: mean + stdDev * deviation, lower: mean - stdDev * deviation, deviation };
}

function macdHistogram(values, fast = 12, slow = 26, signal = 9) {
  if (!Array.isArray(values) || values.length < slow + signal + 3) return null;
  const macdSeries = [];
  for (let i = slow; i <= values.length; i += 1) {
    const slice = values.slice(0, i);
    const fastEma = ema(slice, fast);
    const slowEma = ema(slice, slow);
    if (fastEma == null || slowEma == null) continue;
    macdSeries.push(fastEma - slowEma);
  }
  if (macdSeries.length < signal) return null;
  const macd = last(macdSeries);
  const signalLine = ema(macdSeries, signal);
  if (signalLine == null) return null;
  return macd - signalLine;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  const slice = values.slice(-(period + 1));
  for (let i = 1; i < slice.length; i += 1) {
    const diff = slice[i] - slice[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period || 1e-9);
  return 100 - (100 / (1 + rs));
}

function realizedVolPct(values, period = 20) {
  if (!Array.isArray(values) || values.length < period) return null;
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  if (!mean) return null;
  const variance = slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / slice.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function recentDigitStreak(digits) {
  if (!digits.length) return { digit: null, streak: 0 };
  const digit = last(digits);
  let streak = 1;
  for (let i = digits.length - 2; i >= 0; i -= 1) {
    if (digits[i] !== digit) break;
    streak += 1;
  }
  return { digit, streak };
}

function digitHistogram(digits, window) {
  if (!Array.isArray(digits) || digits.length < window) return null;
  const slice = digits.slice(-window);
  const counts = Array.from({ length: 10 }, () => 0);
  for (const d of slice) counts[d] += 1;
  const even = slice.filter((d) => d % 2 === 0).length;
  const high = slice.filter((d) => d >= 5).length;
  return {
    counts,
    total: slice.length,
    evenPct: (even / slice.length) * 100,
    oddPct: ((slice.length - even) / slice.length) * 100,
    highPct: (high / slice.length) * 100,
    lowPct: ((slice.length - high) / slice.length) * 100,
    unique: new Set(slice).size
  };
}

function candleColor(candle) {
  if (!candle) return 'neutral';
  if (candle.close > candle.open) return 'green';
  if (candle.close < candle.open) return 'red';
  return 'neutral';
}



function humanizeFilterType(filterType, mode) {
  const lookup = {
    rise_fall: {
      ema_cross: 'EMA cross',
      ema_macd_cross: 'EMA + MACD',
      bollinger_breakout: 'BB bounce',
      bollinger_hull_breakout: 'BB + Hull',
      tick_momentum: 'Trend pullback',
      trend_pullback_continuation: 'Trend pullback'
    },
    over_under: {
      digit_histogram: 'Digit histogram',
      digit_histogram_analysis: 'Digit histogram',
      hit_and_run: 'Hit and run',
      under2_reversal: 'Under 2 reversal'
    },
    digits: {
      even_odd_bias: 'Parity bias',
      even_odd_3ma: 'Parity bias',
      differs_rotation: 'Differs rotation',
      hot_digit_cluster: 'Hot digit cluster'
    },
    accumulator: {
      accumulator_watch: 'Accumulator watch',
      accumulator_sideways: 'Accumulator watch'
    }
  };
  return lookup[mode]?.[filterType] || String(filterType || '').replace(/_/g, ' ').trim();
}

function normalizeLegacyFilter(mode, filter = {}) {
  const normalized = { ...(filter || {}) };
  const aliases = {
    rise_fall: {
      ema_cross: 'ema_macd_cross',
      bollinger_breakout: 'bollinger_hull_breakout',
      tick_momentum: 'trend_pullback_continuation'
    },
    over_under: {
      digit_histogram: 'digit_histogram_analysis'
    },
    digits: {
      even_odd_bias: 'even_odd_3ma'
    },
    accumulator: {
      accumulator_watch: 'accumulator_sideways'
    }
  };
  const mapped = aliases[mode] && aliases[mode][normalized.type];
  if (mapped) normalized.type = mapped;
  return normalized;
}

function computeStrategySignal({ mode, settings, ticks = [], digits = [], candles = [], state = {} }) {
  const filter = normalizeLegacyFilter(mode, settings?.entryFilter || {});
  const prices = candles.length ? candles.map((c) => Number(c.close)) : ticks.slice();
  const lastPrice = last(prices);
  const lastDigit = last(digits);
  const recentStreak = recentDigitStreak(digits);

  if (!filter || !mode) return { trade: false, reason: 'No strategy loaded' };

  if (mode === 'rise_fall') {
    if (filter.type === 'ema_macd_cross') {
      const fast = clampNumber(filter.fastPeriod, 10);
      const slow = clampNumber(filter.slowPeriod, 20);
      const minConfirm = clampNumber(filter.minTicksConfirm, 2);
      if (prices.length < slow + minConfirm + 30) return { trade: false, reason: `Waiting for ${slow + minConfirm} ticks` };
      const fastNow = ema(prices, fast);
      const fastPrev = ema(prices.slice(0, -1), fast);
      const slowNow = ema(prices, slow);
      const slowPrev = ema(prices.slice(0, -1), slow);
      const macdHist = macdHistogram(prices, 12, 26, 9);
      const currentRsi = rsi(prices, clampNumber(filter.rsiPeriod, 14));
      const vol = realizedVolPct(prices, 20);
      const guard = clampNumber(filter.volatilityGuardPct, 0.4);
      if (vol != null && guard != null && vol > guard) return { trade: false, reason: `Volatility guard ${vol.toFixed(2)}%` };
      if ([fastNow, fastPrev, slowNow, slowPrev, macdHist].some((v) => v == null)) return { trade: false, reason: 'Waiting for EMA/MACD' };
      const recentMoves = prices.slice(-(minConfirm + 1));
      const upConfirm = recentMoves.every((p, i, arr) => i === 0 || p >= arr[i - 1]);
      const downConfirm = recentMoves.every((p, i, arr) => i === 0 || p <= arr[i - 1]);
      if (fastPrev <= slowPrev && fastNow > slowNow && macdHist >= clampNumber(filter.macdThreshold, 0.1) && currentRsi >= clampNumber(filter.rsiLongFloor, 50) && upConfirm) {
        return { trade: true, direction: 'RISE', reason: 'RISE EMA + MACD confluence' };
      }
      if (fastPrev >= slowPrev && fastNow < slowNow && macdHist <= -clampNumber(filter.macdThreshold, 0.1) && currentRsi <= clampNumber(filter.rsiShortCeil, 50) && downConfirm) {
        return { trade: true, direction: 'FALL', reason: 'FALL EMA + MACD confluence' };
      }
      return { trade: false, reason: 'EMA/MACD not aligned' };
    }

    if (filter.type === 'bollinger_hull_breakout') {
      const bb = bollinger(prices, clampNumber(filter.bbPeriod, 20), clampNumber(filter.bbStdDev, 2));
      const hullNow = hma(prices, clampNumber(filter.hullPeriod, 14));
      const hullPrev = hma(prices.slice(0, -1), clampNumber(filter.hullPeriod, 14));
      const macdHist = macdHistogram(prices, 12, 26, 9);
      if (!bb || hullNow == null || hullPrev == null || macdHist == null) return { trade: false, reason: 'Waiting for BB/Hull/MACD' };
      if (lastPrice < bb.lower && hullNow > hullPrev && macdHist >= clampNumber(filter.macdThreshold, 0.2)) {
        return { trade: true, direction: 'RISE', reason: 'RISE BB bounce + Hull confirmation' };
      }
      if (lastPrice > bb.upper && hullNow < hullPrev && macdHist <= -clampNumber(filter.macdThreshold, 0.2)) {
        return { trade: true, direction: 'FALL', reason: 'FALL BB bounce + Hull confirmation' };
      }
      return { trade: false, reason: 'BB/Hull breakout not aligned' };
    }

    if (filter.type === 'trend_pullback_continuation') {
      const fast = clampNumber(filter.fastPeriod, 9);
      const slow = clampNumber(filter.slowPeriod, 21);
      if (prices.length < slow + 5) return { trade: false, reason: `Waiting for ${slow + 5} ticks` };
      const fastNow = ema(prices, fast);
      const slowNow = ema(prices, slow);
      const move1 = prices[prices.length - 1] - prices[prices.length - 2];
      const move2 = prices[prices.length - 2] - prices[prices.length - 3];
      const move3 = prices[prices.length - 3] - prices[prices.length - 4];
      if (fastNow > slowNow && move3 > 0 && move2 < 0 && move1 > 0) {
        return { trade: true, direction: 'RISE', reason: 'RISE trend pullback continuation' };
      }
      if (fastNow < slowNow && move3 < 0 && move2 > 0 && move1 < 0) {
        return { trade: true, direction: 'FALL', reason: 'FALL trend pullback continuation' };
      }
      return { trade: false, reason: 'Trend pullback not aligned' };
    }
  }

  if (mode === 'over_under') {
    if (filter.type === 'hit_and_run') {
      const lookback = clampNumber(filter.volatilityWindow, 4);
      if (digits.length < lookback + 2) return { trade: false, reason: `Waiting for ${lookback + 2} digits` };
      const recent = digits.slice(-lookback);
      const range = Math.max(...recent) - Math.min(...recent);
      if (range < clampNumber(filter.minDigitRange, 3)) return { trade: false, reason: '3-tick volatility not present' };
      if (lastDigit <= 1) return { trade: true, direction: 'OVER', contractType: 'DIGITOVER', barrier: 1, reason: 'Hit-and-run over 1 after 3-tick volatility' };
      if (lastDigit >= 8) return { trade: true, direction: 'UNDER', contractType: 'DIGITUNDER', barrier: 8, reason: 'Hit-and-run under 8 after 3-tick volatility' };
      return { trade: false, reason: 'No edge digit for hit-and-run' };
    }

    if (filter.type === 'digit_histogram_analysis') {
      const hist = digitHistogram(digits, clampNumber(filter.window, 50));
      if (!hist) return { trade: false, reason: `Waiting for ${clampNumber(filter.window, 50)} digits` };
      const targetRange = Array.isArray(filter.targetRange) ? filter.targetRange : [5, 6, 7, 8, 9];
      const rangePct = (targetRange.reduce((sum, d) => sum + hist.counts[d], 0) / hist.total) * 100;
      const threshold = clampNumber(filter.minBiasPct, 60);
      if (settings.tradeType === 'DIGITOVER' || settings.tradeType === 'AUTO_DIGIT') {
        if (rangePct >= threshold) {
          return { trade: true, direction: 'OVER', contractType: 'DIGITOVER', barrier: clampNumber(filter.overBarrier, settings.barrier ?? 4), reason: `High digits ${rangePct.toFixed(0)}% >= ${threshold}%` };
        }
      }
      const lowRange = [0, 1, 2, 3, 4];
      const lowPct = (lowRange.reduce((sum, d) => sum + hist.counts[d], 0) / hist.total) * 100;
      if ((settings.tradeType === 'DIGITUNDER' || settings.tradeType === 'AUTO_DIGIT') && lowPct >= threshold) {
        return { trade: true, direction: 'UNDER', contractType: 'DIGITUNDER', barrier: clampNumber(filter.underBarrier, settings.barrier ?? 5), reason: `Low digits ${lowPct.toFixed(0)}% >= ${threshold}%` };
      }
      return { trade: false, reason: `Digit bias below ${threshold}%` };
    }

    if (filter.type === 'under2_reversal') {
      if (prices.length < 12 || digits.length < 20) return { trade: false, reason: 'Waiting for reversal context' };
      const recentPrices = prices.slice(-6);
      const spike = Math.max(...recentPrices) - Math.min(...recentPrices);
      const mean = recentPrices.reduce((a, b) => a + b, 0) / recentPrices.length;
      const spikePct = mean ? (spike / mean) * 100 : 0;
      const stabilizing = Math.abs(recentPrices[recentPrices.length - 1] - recentPrices[recentPrices.length - 2]) < Math.abs(recentPrices[1] - recentPrices[0]);
      const hist = digitHistogram(digits, 20);
      const low2Pct = ((hist.counts[0] + hist.counts[1]) / hist.total) * 100;
      const flatRange = (Math.max(...recentPrices.slice(-4)) - Math.min(...recentPrices.slice(-4))) / mean * 100;
      if ((spikePct >= clampNumber(filter.minSpikePct, 0.12) && stabilizing && low2Pct >= clampNumber(filter.minLowBiasPct, 18)) || flatRange <= clampNumber(filter.flatRangePct, 0.03)) {
        return { trade: true, direction: 'UNDER', contractType: 'DIGITUNDER', barrier: 2, reason: 'Under 2 spike-reversal trap' };
      }
      return { trade: false, reason: 'Under 2 conditions not aligned' };
    }
  }

  if (mode === 'digits') {
    if (filter.type === 'even_odd_3ma') {
      const windows = Array.isArray(filter.windows) ? filter.windows : [50, 100];
      for (const window of windows) {
        const hist = digitHistogram(digits, window);
        if (!hist) return { trade: false, reason: `Waiting for ${window} digits` };
        const threshold = clampNumber((filter.thresholds || {})[window], 58);
        if (hist.evenPct < threshold && hist.oddPct < threshold) return { trade: false, reason: `Bias below ${threshold}% on ${window}T` };
      }
      if (candles.length < Math.max(filter.ma1Period || 10, filter.ma2Period || 20, filter.ma3Period || 100)) return { trade: false, reason: 'Waiting for 3MA context' };
      const price = last(candles).close;
      const ma1 = ema(candles.map((c) => c.close), clampNumber(filter.ma1Period, 10));
      const ma2 = ema(candles.map((c) => c.close), clampNumber(filter.ma2Period, 20));
      const ma3 = ema(candles.map((c) => c.close), clampNumber(filter.ma3Period, 100));
      const histPrimary = digitHistogram(digits, windows[0]);
      const edge = Math.abs(histPrimary.evenPct - histPrimary.oddPct);
      if (edge < clampNumber(filter.minEdgePct, 6)) return { trade: false, reason: `Edge below ${clampNumber(filter.minEdgePct, 6)}%` };
      const color = candleColor(last(candles));
      if (ma1 > price && ma2 > price && ma3 > price && color === 'red' && histPrimary.evenPct >= histPrimary.oddPct) {
        return { trade: true, direction: 'EVEN', contractType: 'DIGITEVEN', reason: `3MA even bias ${histPrimary.evenPct.toFixed(1)}%` };
      }
      if (ma1 < price && ma2 < price && ma3 < price && color === 'green' && histPrimary.oddPct >= histPrimary.evenPct) {
        return { trade: true, direction: 'ODD', contractType: 'DIGITODD', reason: `3MA odd bias ${histPrimary.oddPct.toFixed(1)}%` };
      }
      return { trade: false, reason: '3MA parity not aligned' };
    }

    if (filter.type === 'differs_rotation') {
      const window = clampNumber(filter.tickWindow, 10);
      const hist = digitHistogram(digits, window);
      if (!hist) return { trade: false, reason: `Waiting for ${window} digits` };
      if (recentStreak.streak >= clampNumber(filter.recentDigitVeto, 3)) return { trade: false, reason: `Recent digit streak veto (${recentStreak.streak})` };
      if (hist.unique < clampNumber(filter.minUniqueDigits, 6)) return { trade: false, reason: 'Rotation waiting for better digit spread' };
      const rotateDigits = Array.isArray(filter.rotateDigits) ? filter.rotateDigits : [0,1,2,3,4,5,6,7,8,9];
      const recent = digits.slice(-window);
      let digit = null;
      let nextIndex = Number.isFinite(state.rotationIndex) ? state.rotationIndex : 0;
      for (let i = 0; i < rotateDigits.length; i += 1) {
        const candidate = rotateDigits[(nextIndex + i) % rotateDigits.length];
        if (!recent.includes(candidate)) {
          digit = candidate;
          nextIndex = (nextIndex + i + 1) % rotateDigits.length;
          break;
        }
      }
      if (digit == null) return { trade: false, reason: 'Differs rotation found no clean digit' };
      return { trade: true, direction: 'DIFFERS', contractType: 'DIGITDIFFERS', barrier: digit, nextState: { rotationIndex: nextIndex }, reason: `Differs rotation avoiding recent digit ${digit}` };
    }

    if (filter.type === 'hot_digit_cluster') {
      const window = clampNumber(filter.window, 10);
      const hist = digitHistogram(digits, window);
      if (!hist) return { trade: false, reason: `Waiting for ${window} digits` };
      const targets = Array.isArray(filter.targetDigits) ? filter.targetDigits : [8, 9];
      const minRepeats = clampNumber(filter.minRepeats, 4);
      let bestDigit = null;
      let bestCount = 0;
      for (const digit of targets) {
        const count = hist.counts[digit] || 0;
        if (count > bestCount) { bestCount = count; bestDigit = digit; }
      }
      if (bestDigit != null && bestCount >= minRepeats) {
        return { trade: true, direction: 'MATCH', contractType: 'DIGITMATCH', barrier: bestDigit, reason: `Hot digit ${bestDigit} repeated ${bestCount}/${window}` };
      }
      return { trade: false, reason: 'No hot digit cluster' };
    }
  }

  const setupLabel = humanizeFilterType(filter.type, mode);
  return { trade: false, reason: setupLabel ? `Waiting for ${setupLabel} setup` : 'Waiting for setup' };
}

module.exports = {
  computeStrategySignal,
  helpers: {
    ema,
    sma,
    wma,
    hma,
    bollinger,
    macdHistogram,
    rsi,
    realizedVolPct,
    recentDigitStreak,
    digitHistogram,
    candleColor
  }
};
