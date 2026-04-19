function evaluateRisk({ snapshot = {} }) {
  const lossStreak = Number(snapshot.lossStreak || 0);
  if (lossStreak >= 3) return { level: 'high', message: 'Loss streak elevated. Pause and reassess entry quality.' };
  if (lossStreak >= 2) return { level: 'medium', message: 'Caution: tighten risk settings.' };
  return { level: 'low', message: 'Risk state normal.' };
}
module.exports = { evaluateRisk };
