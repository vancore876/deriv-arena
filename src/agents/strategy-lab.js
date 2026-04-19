function reviewStrategy({ recentTrades = [] }) {
  const wins = recentTrades.filter((t) => Number(t?.profit) > 0).length;
  const total = recentTrades.length || 0;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
  return {
    winRate,
    strategyHealth: winRate >= 55 ? 'good' : winRate >= 45 ? 'neutral' : 'weak',
    recommendation: winRate < 45 ? 'Reduce risk and increase cooldown until win rate improves.' : 'Keep current preset and monitor drawdown.'
  };
}
module.exports = { reviewStrategy };
