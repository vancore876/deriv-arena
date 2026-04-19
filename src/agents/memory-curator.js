function buildMemoryInsights({ recentTrades = [] }) {
  const last = recentTrades.slice(-5);
  return {
    recentSample: last.length,
    note: last.length ? 'Memory updated from latest trades.' : 'No trade memory yet.'
  };
}
module.exports = { buildMemoryInsights };
