function detectRegime({ snapshot = {} }) {
  const move = Math.abs(Number(snapshot.movePercent || 0));
  return { regime: move > 0.08 ? 'high-volatility' : 'balanced' };
}
module.exports = { detectRegime };
