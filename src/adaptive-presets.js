function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function suggestAdaptivePatch({ mode, settings = {}, regime = {}, review = {} } = {}) {
  const patch = { entryFilter: {} };
  let changed = false;

  if (review.lossRate >= 0.6) {
    patch.cooldownMs = Math.max(Number(settings.cooldownMs || 0), 2500);
    patch.maxTradesPerSession = Math.min(Number(settings.maxTradesPerSession || 9999), 20);
    changed = true;
  }

  if (mode === 'rise_fall') {
    const current = settings.entryFilter || {};
    if (review.lossRate >= 0.5) {
      patch.entryFilter.minTicksConfirm = Math.max(Number(current.minTicksConfirm || 2), 3);
      patch.entryFilter.rsiLongFloor = clamp(Number(current.rsiLongFloor || 52) + 2, 50, 65);
      patch.entryFilter.rsiShortCeil = clamp(Number(current.rsiShortCeil || 48) - 2, 35, 50);
      changed = true;
    }
  }

  if (mode === 'over_under') {
    const current = settings.entryFilter || {};
    if (review.lossRate >= 0.5 || regime.recommendation === 'digits_or_over_under') {
      patch.entryFilter.minBiasPct = Math.max(Number(current.minBiasPct || 60), 64);
      patch.entryFilter.recentStreakVeto = Math.max(Number(current.recentStreakVeto || 4), 5);
      patch.entryFilter.qualityWindow = Math.max(Number(current.qualityWindow || 10), 12);
      changed = true;
    }
  }

  if (mode === 'digits') {
    const current = settings.entryFilter || {};
    if (review.lossRate >= 0.5) {
      patch.entryFilter.minEdgePct = Math.max(Number(current.minEdgePct || 6), 8);
      patch.entryFilter.streakVeto = Math.max(Number(current.streakVeto || 4), 5);
      changed = true;
    }
  }

  if (mode === 'accumulator') {
    const current = settings.entryFilter || {};
    patch.entryFilter.minTrendBiasPct = Math.max(Number(current.minTrendBiasPct || 57), 60);
    patch.entryFilter.maxRealizedVolPct = Math.min(Number(current.maxRealizedVolPct || 0.15), 0.12);
    patch.entryFilter.stepPct = clamp(Number(current.stepPct || 0.3), 0.01, 0.05);
    changed = true;
  }

  return changed ? patch : null;
}

module.exports = { suggestAdaptivePatch };
