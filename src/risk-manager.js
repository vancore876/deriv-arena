function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOptional(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function evaluateRiskGate(ctx = {}) {
  const stats = ctx.stats || {};
  const settings = ctx.settings || {};
  const tradeHistory = Array.isArray(ctx.tradeHistory) ? ctx.tradeHistory : [];
  const currentStake = num(ctx.currentStake, settings.stakeAmount || 0.35);
  const baseBalance = num(ctx.sessionStartBalance || ctx.balance, 0);
  const sessionPnl = num(stats.sessionPnl, 0);
  const drawdown = num(stats.peakPnl, 0) - sessionPnl;
  const lastFew = tradeHistory.slice(0, 5);
  const recentLosses = lastFew.filter((t) => t.result === 'lost').length;

  const maxLossStreak = normalizeOptional(settings.maxLossStreak);
  if (maxLossStreak !== null && num(stats.lossStreak, 0) >= maxLossStreak) {
    return { allow: false, reason: `Loss streak cap hit (${stats.lossStreak}/${maxLossStreak})`, severity: 'warn', code: 'loss_streak' };
  }

  const maxTradesPerSession = normalizeOptional(settings.maxTradesPerSession);
  if (maxTradesPerSession !== null && num(stats.trades, 0) >= maxTradesPerSession) {
    return { allow: false, reason: `Max trades reached (${stats.trades}/${maxTradesPerSession})`, severity: 'warn', code: 'max_trades' };
  }

  const stopLossPct = normalizeOptional(settings.stopLossPct);
  if (stopLossPct !== null && baseBalance > 0 && sessionPnl <= -(baseBalance * stopLossPct / 100)) {
    return { allow: false, reason: `Session stop loss hit (${stopLossPct}%)`, severity: 'error', code: 'session_stop' };
  }

  const dailyLossPct = normalizeOptional(settings.dailyLossPct);
  if (dailyLossPct !== null && baseBalance > 0 && sessionPnl <= -(baseBalance * dailyLossPct / 100)) {
    return { allow: false, reason: `Daily loss guard hit (${dailyLossPct}%)`, severity: 'error', code: 'daily_loss' };
  }

  const maxOpenTrades = normalizeOptional(settings.maxOpenTrades);
  if (maxOpenTrades !== null && num(ctx.openTrades, 0) >= maxOpenTrades) {
    return { allow: false, reason: `Max open trades reached (${ctx.openTrades}/${maxOpenTrades})`, severity: 'warn', code: 'max_open_trades' };
  }

  if (recentLosses >= 4) {
    return { allow: false, reason: 'Recent loss cluster detected (4 of last 5)', severity: 'warn', code: 'loss_cluster' };
  }

  const quality = {
    currentStake,
    drawdown: Math.max(0, drawdown),
    recentLosses,
    sessionPnl,
    baseBalance
  };

  return { allow: true, reason: 'Risk gate clear', severity: 'info', code: 'clear', quality };
}

module.exports = {
  evaluateRiskGate,
  normalizeOptional,
};
