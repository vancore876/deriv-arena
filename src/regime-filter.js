function ema(values = [], period = 9) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let acc = values.slice(0, period).reduce((a, b) => a + Number(b || 0), 0) / period;
  for (let i = period; i < values.length; i += 1) acc = (Number(values[i] || 0) * k) + (acc * (1 - k));
  return acc;
}

function realizedVolPct(values = [], lookback = 30) {
  if (!Array.isArray(values) || values.length < lookback) return null;
  const slice = values.slice(-lookback).map(Number).filter(Number.isFinite);
  if (slice.length < lookback) return null;
  const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
  if (!mean) return null;
  const variance = slice.reduce((acc, value) => acc + ((value - mean) ** 2), 0) / slice.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function digitEntropy(digits = [], window = 50) {
  const slice = digits.slice(-window);
  if (slice.length < window) return null;
  const counts = new Map();
  slice.forEach((d) => counts.set(d, (counts.get(d) || 0) + 1));
  let h = 0;
  for (const c of counts.values()) {
    const p = c / slice.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function assessRegime(ctx = {}) {
  const ticks = Array.isArray(ctx.ticks) ? ctx.ticks : [];
  const digits = Array.isArray(ctx.digits) ? ctx.digits : [];
  const fast = ema(ticks, 9);
  const slow = ema(ticks, 21);
  const vol = realizedVolPct(ticks, 30);
  const entropy = digitEntropy(digits, 50);
  const trendStrength = fast && slow ? Math.abs((fast - slow) / slow) * 100 : 0;

  let regime = 'unknown';
  let recommendation = 'wait';
  let confidence = 0.4;

  if (vol !== null && vol <= 0.08 && trendStrength < 0.03) {
    regime = 'stable_range';
    recommendation = 'accumulator_or_over_under';
    confidence = 0.75;
  } else if (vol !== null && trendStrength >= 0.03) {
    regime = 'trend';
    recommendation = 'rise_fall_or_smc';
    confidence = 0.78;
  } else if (vol !== null && vol >= 0.2) {
    regime = 'chaotic';
    recommendation = 'stand_down';
    confidence = 0.82;
  }

  if (entropy !== null && entropy < 2.8) {
    recommendation = 'digits_or_over_under';
    confidence = Math.max(confidence, 0.65);
  }

  return { regime, recommendation, confidence, volatilityPct: vol, trendStrengthPct: trendStrength, digitEntropy: entropy };
}

module.exports = { assessRegime };
