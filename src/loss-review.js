function reviewLosses(history = []) {
  const recent = history.slice(0, 12);
  const losses = recent.filter((trade) => trade.result === 'lost');
  const wins = recent.filter((trade) => trade.result === 'won');
  const byMode = {};
  const byMarket = {};
  for (const trade of losses) {
    const mode = trade.mode || 'unknown';
    const market = trade.market || 'unknown';
    byMode[mode] = (byMode[mode] || 0) + 1;
    byMarket[market] = (byMarket[market] || 0) + 1;
  }
  const dominantMode = Object.entries(byMode).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const dominantMarket = Object.entries(byMarket).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const lossRate = recent.length ? losses.length / recent.length : 0;
  const recommendation = [];
  if (lossRate >= 0.6) recommendation.push('tighten_filters');
  if (losses.length >= 4) recommendation.push('increase_cooldown');
  if (dominantMode) recommendation.push(`review_${dominantMode}`);
  return {
    sample: recent.length,
    losses: losses.length,
    wins: wins.length,
    lossRate,
    dominantMode,
    dominantMarket,
    recommendation,
  };
}

module.exports = { reviewLosses };
