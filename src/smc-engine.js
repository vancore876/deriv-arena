const DEFAULTS = {
  enabled: true,
  useKillZones: true,
  useLiquiditySweeps: true,
  useFairValueGaps: true,
  useOrderBlocks: true,
  allowLongs: true,
  allowShorts: true,
  swingLookback: 2,
  minImpulseAtr: 0.8,
  stopBufferAtr: 0.2,
  targetRMultiple: 2.5,
  minAtr: 0.0001,
  trailing: {
    enabled: true,
    breakEvenAtR: 1.0,
    lockInAtR: 1.5,
    lockInR: 0.5,
    trailAtrMult: 1.2
  }
};

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function mergeSettings(base = {}, patch = {}) {
  return {
    ...DEFAULTS,
    ...base,
    ...patch,
    trailing: {
      ...DEFAULTS.trailing,
      ...(base.trailing || {}),
      ...(patch.trailing || {})
    }
  };
}

function averageTrueRange(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length < 2) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i += 1) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      toNum(c.high) - toNum(c.low),
      Math.abs(toNum(c.high) - toNum(prev.close)),
      Math.abs(toNum(c.low) - toNum(prev.close))
    );
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  if (!slice.length) return null;
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function findSwingPoints(candles, lookback = 2) {
  const highs = [];
  const lows = [];
  for (let i = lookback; i < candles.length - lookback; i += 1) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j += 1) {
      if (j === i) continue;
      if (toNum(candles[j].high) >= toNum(c.high)) isHigh = false;
      if (toNum(candles[j].low) <= toNum(c.low)) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: toNum(c.high), time: c.time });
    if (isLow) lows.push({ index: i, price: toNum(c.low), time: c.time });
  }
  return { highs, lows };
}

function findLatestFvg(candles, side) {
  for (let i = candles.length - 1; i >= 2; i -= 1) {
    const a = candles[i - 2];
    const c = candles[i];
    if (side === 'buy' && toNum(a.high) < toNum(c.low)) {
      return { side, top: toNum(c.low), bottom: toNum(a.high), index: i, time: c.time };
    }
    if (side === 'sell' && toNum(a.low) > toNum(c.high)) {
      return { side, top: toNum(a.low), bottom: toNum(c.high), index: i, time: c.time };
    }
  }
  return null;
}

function findOrderBlock(candles, side) {
  for (let i = candles.length - 3; i >= 1; i -= 1) {
    const c = candles[i];
    const next = candles[i + 1];
    const body = Math.abs(toNum(c.close) - toNum(c.open));
    const nextBody = Math.abs(toNum(next.close) - toNum(next.open));
    if (side === 'buy' && toNum(c.close) < toNum(c.open) && toNum(next.close) > toNum(next.open) && nextBody > body) {
      return { side, high: toNum(c.high), low: toNum(c.low), index: i, time: c.time };
    }
    if (side === 'sell' && toNum(c.close) > toNum(c.open) && toNum(next.close) < toNum(next.open) && nextBody > body) {
      return { side, high: toNum(c.high), low: toNum(c.low), index: i, time: c.time };
    }
  }
  return null;
}

function inKillZone(epochSec) {
  const d = new Date(epochSec * 1000);
  const h = d.getUTCHours();
  return (h >= 7 && h <= 10) || (h >= 12 && h <= 16);
}

function detectLiquiditySweep(last, swingHigh, swingLow) {
  const bullSweep = swingLow && toNum(last.low) < swingLow.price && toNum(last.close) > swingLow.price;
  const bearSweep = swingHigh && toNum(last.high) > swingHigh.price && toNum(last.close) < swingHigh.price;
  return {
    bullSweep,
    bearSweep
  };
}

function determineStructure(candles, swings) {
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const lastHigh = swings.highs[swings.highs.length - 1] || null;
  const prevHigh = swings.highs[swings.highs.length - 2] || null;
  const lastLow = swings.lows[swings.lows.length - 1] || null;
  const prevLow = swings.lows[swings.lows.length - 2] || null;

  let bias = 'neutral';
  if (lastHigh && prevHigh && lastLow && prevLow) {
    if (lastHigh.price > prevHigh.price && lastLow.price > prevLow.price) bias = 'bullish';
    else if (lastHigh.price < prevHigh.price && lastLow.price < prevLow.price) bias = 'bearish';
  }

  const bosUp = lastHigh && toNum(last.close) > lastHigh.price && toNum(prev.close) <= lastHigh.price;
  const bosDown = lastLow && toNum(last.close) < lastLow.price && toNum(prev.close) >= lastLow.price;
  const chochUp = bias === 'bearish' && bosUp;
  const chochDown = bias === 'bullish' && bosDown;

  return { bias, bosUp, bosDown, chochUp, chochDown, lastHigh, lastLow };
}

function buildSignal(candles, opts = {}) {
  const settings = mergeSettings({}, opts.settings || {});
  if (!settings.enabled || candles.length < 30) return { signal: null, diagnostics: { reason: 'not_enough_candles' } };

  const last = candles[candles.length - 1];
  const swings = findSwingPoints(candles, settings.swingLookback);
  const structure = determineStructure(candles, swings);
  const atr = Math.max(averageTrueRange(candles, 14) || settings.minAtr, settings.minAtr);
  const sweep = detectLiquiditySweep(last, structure.lastHigh, structure.lastLow);
  const bullishTrigger = (structure.bosUp || structure.chochUp || sweep.bullSweep) && settings.allowLongs;
  const bearishTrigger = (structure.bosDown || structure.chochDown || sweep.bearSweep) && settings.allowShorts;

  const diagnostics = {
    atr,
    structure,
    sweep,
    killZone: inKillZone(last.time),
    lastTime: last.time
  };

  if (settings.useKillZones && !diagnostics.killZone) return { signal: null, diagnostics: { ...diagnostics, reason: 'outside_killzone' } };

  const impulse = Math.abs(toNum(last.close) - toNum(last.open));
  if (impulse < atr * settings.minImpulseAtr) return { signal: null, diagnostics: { ...diagnostics, reason: 'impulse_too_small' } };

  let side = null;
  if (bullishTrigger && !bearishTrigger) side = 'buy';
  if (bearishTrigger && !bullishTrigger) side = 'sell';
  if (!side) return { signal: null, diagnostics: { ...diagnostics, reason: 'no_structure_trigger' } };

  const fvg = settings.useFairValueGaps ? findLatestFvg(candles, side) : null;
  const ob = settings.useOrderBlocks ? findOrderBlock(candles, side) : null;

  const entry = toNum(last.close);
  let sl;
  if (side === 'buy') {
    const referenceLow = Math.min(
      structure.lastLow?.price ?? entry - atr,
      ob?.low ?? entry - atr,
      fvg?.bottom ?? entry - atr
    );
    sl = referenceLow - atr * settings.stopBufferAtr;
  } else {
    const referenceHigh = Math.max(
      structure.lastHigh?.price ?? entry + atr,
      ob?.high ?? entry + atr,
      fvg?.top ?? entry + atr
    );
    sl = referenceHigh + atr * settings.stopBufferAtr;
  }

  const risk = Math.max(Math.abs(entry - sl), atr * 0.5);
  const tp = side === 'buy'
    ? entry + risk * settings.targetRMultiple
    : entry - risk * settings.targetRMultiple;

  return {
    signal: {
      side,
      symbol: opts.symbol,
      entry,
      sl,
      tp,
      risk,
      atr,
      rationale: [
        structure.bosUp || structure.bosDown ? 'BOS' : null,
        structure.chochUp || structure.chochDown ? 'CHOCH' : null,
        sweep.bullSweep || sweep.bearSweep ? 'LiquiditySweep' : null,
        fvg ? 'FVG' : null,
        ob ? 'OrderBlock' : null
      ].filter(Boolean).join(' + '),
      diagnostics: { ...diagnostics, fvg, ob }
    },
    diagnostics
  };
}

function buildTrailingPlan(position, candles, options = {}) {
  const settings = mergeSettings({}, options.settings || {});
  if (!settings.trailing.enabled || !position || candles.length < 5) return null;
  const atr = Math.max(averageTrueRange(candles, 14) || settings.minAtr, settings.minAtr);
  const last = candles[candles.length - 1];
  const entry = toNum(position.price_open || position.entry || 0);
  const currentSl = toNum(position.sl || 0);
  const tp = toNum(position.tp || 0);
  const side = Number(position.type) === 1 || position.side === 'sell' ? 'sell' : 'buy';
  const price = toNum(last.close);
  const initialRisk = side === 'buy' ? Math.max(entry - currentSl, atr) : Math.max(currentSl - entry, atr);
  const r = side === 'buy' ? (price - entry) / initialRisk : (entry - price) / initialRisk;
  if (!Number.isFinite(r) || r <= 0) return null;

  let nextSl = currentSl;
  if (r >= settings.trailing.breakEvenAtR) {
    nextSl = side === 'buy' ? Math.max(nextSl, entry) : Math.min(nextSl || entry, entry);
  }
  if (r >= settings.trailing.lockInAtR) {
    const lockPrice = side === 'buy'
      ? entry + initialRisk * settings.trailing.lockInR
      : entry - initialRisk * settings.trailing.lockInR;
    nextSl = side === 'buy' ? Math.max(nextSl, lockPrice) : (nextSl === 0 ? lockPrice : Math.min(nextSl, lockPrice));
  }
  const atrTrail = side === 'buy'
    ? price - atr * settings.trailing.trailAtrMult
    : price + atr * settings.trailing.trailAtrMult;
  nextSl = side === 'buy' ? Math.max(nextSl, atrTrail) : (nextSl === 0 ? atrTrail : Math.min(nextSl, atrTrail));

  if (tp && ((side === 'buy' && nextSl >= tp) || (side === 'sell' && nextSl <= tp))) return null;
  if (Math.abs(nextSl - currentSl) < atr * 0.1) return null;

  return {
    position_ticket: Number(position.ticket || position.position_ticket),
    sl: Number(nextSl.toFixed(5)),
    tp: tp || 0,
    reason: `trail_${r.toFixed(2)}R`
  };
}

module.exports = {
  DEFAULT_SMC_SETTINGS: clone(DEFAULTS),
  mergeSmcSettings: mergeSettings,
  buildSmcSignal: buildSignal,
  buildTrailingPlan,
  averageTrueRange
};
