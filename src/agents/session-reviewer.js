function summarizeSession({ snapshot = {}, recentTrades = [] }) {
  const wins = Number(snapshot.wins || 0);
  const losses = Number(snapshot.losses || 0);
  const total = recentTrades.length || wins + losses;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  return {
    winRate,
    summary: `Session ${snapshot.running ? 'running' : 'idle'} with ${wins}W/${losses}L and ${Number(snapshot.sessionProfit || 0).toFixed(2)} PnL.`
  };
}
module.exports = { summarizeSession };
