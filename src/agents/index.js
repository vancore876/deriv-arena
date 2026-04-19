const { reviewStrategy } = require('./strategy-lab.js');
const { summarizeSession } = require('./session-reviewer.js');
const { evaluateRisk } = require('./risk-guardian.js');
const { buildMemoryInsights } = require('./memory-curator.js');
const { detectRegime } = require('./regime-agent.js');

class OpenClawOrchestrator {
  run(snapshot = {}) {
    const recentTrades = snapshot.recentTrades || [];
    return {
      strategy: reviewStrategy({ recentTrades, snapshot }),
      session: summarizeSession({ snapshot, recentTrades }),
      risk: evaluateRisk({ snapshot }),
      regime: detectRegime({ snapshot }),
      memory: buildMemoryInsights({ recentTrades }),
      generatedAt: new Date().toISOString()
    };
  }
}

class OpenJarvisCopilot {
  answer({ query = '', context = {}, snapshot = {} } = {}) {
    const q = String(query || '').toLowerCase();
    const missionState = snapshot.missionState || snapshot.overseer || {};
    const overseer = snapshot.overseer || missionState.overseer || {};
    const mt5 = missionState.mt5 || snapshot.mt5 || {};
    const notes = Array.isArray(missionState.assistant?.notes) ? missionState.assistant.notes : [];
    if (q.includes('away') || q.includes('update') || q.includes('summary')) return overseer.autonomousSummary || context.session?.summary || 'Overseer has no away summary yet.';
    if (q.includes('loss') || q.includes('lose') || q.includes('risk')) return `Risk: ${context.risk?.level || 'n/a'} · ${context.risk?.message || ''}`;
    if (q.includes('preset') || q.includes('best') || q.includes('recommend')) return context.strategy?.recommendation || 'Collect more samples before changing presets.';
    if (q.includes('mt5') || q.includes('gold') || q.includes('vix')) return `MT5 venue is ${mt5.venueEnabled ? 'armed' : 'standby'} on ${mt5.activeSymbol || 'XAUUSD'} using ${mt5.style || 'SMC'} logic. ${mt5.lastRecommendation || 'No MT5 recommendation yet.'}`;
    if (q.includes('accumulator')) return 'Accumulators are available as a product focus. Overseer can compare them against digits, rise/fall, and MT5 venues before recommending deployment.';
    if (q.includes('note') || q.includes('remind')) return notes.length ? `Latest note: ${notes[0].text}` : 'No assistant notes saved yet.';
    if (q.includes('plan') || q.includes('help')) return 'Assistant mode can help with planning, notes, summaries, reminders, and trading governance. Ask for a mission, a recap, or a venue recommendation.';
    return `Session summary: ${context.session?.summary || 'No summary yet.'}`;
  }
}

module.exports = { OpenClawOrchestrator, OpenJarvisCopilot };
