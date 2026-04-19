const { OpenClawOrchestrator, OpenJarvisCopilot } = require('./agents/index.js');

function installOpenClawJarvisRoutes({ app, getSnapshot, getBot, broadcast, authMiddleware }) {
  const orchestrator = new OpenClawOrchestrator();
  const copilot = new OpenJarvisCopilot();

  function runAi(snapshot) {
    const insights = orchestrator.run(snapshot || {});
    return { snapshot, insights };
  }

  app.get('/api/version', (_req, res) => {
    res.json({ ok: true, version: process.env.UI_VERSION || 'arena-ai-bridge-1', aiEnabled: true });
  });

  app.post('/api/copilot/query', authMiddleware, (req, res) => {
    const snapshot = getSnapshot(req);
    const { insights } = runAi(snapshot);
    const query = String(req.body?.query || '');
    const reply = copilot.answer({ query, context: insights });
    broadcast(req, 'copilot_reply', { query, reply, generatedAt: new Date().toISOString() });
    res.json({ ok: true, query, reply, context: insights });
  });

  app.get('/api/strategy/review', authMiddleware, (req, res) => {
    const snapshot = getSnapshot(req);
    const { insights } = runAi(snapshot);
    broadcast(req, 'strategy_insight', insights.strategy);
    broadcast(req, 'risk_alert', insights.risk);
    res.json({ ok: true, strategy: insights.strategy, risk: insights.risk, regime: insights.regime, session: insights.session });
  });

  app.get('/api/memory/insights', authMiddleware, (req, res) => {
    const snapshot = getSnapshot(req);
    const { insights } = runAi(snapshot);
    broadcast(req, 'memory_update', insights.memory);
    res.json({ ok: true, memory: insights.memory, generatedAt: insights.generatedAt });
  });



  app.get('/api/mission/state', authMiddleware, (req, res) => {
    const bot = getBot(req);
    const snapshot = getSnapshot(req);
    const state = bot?.getMissionState?.() || { missions: [], agents: [], overseer: {} };
    res.json({ ok: true, missionState: state, snapshot });
  });

  app.post('/api/overseer/command', authMiddleware, (req, res) => {
    const bot = getBot(req);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const { command, payload } = req.body || {};
    const missionState = bot.executeOverseerCommand(command, payload || {});
    broadcast(req, 'mission_state', missionState);
    res.json({ ok: true, missionState });
  });


  app.get('/api/mt5/profile', authMiddleware, (req, res) => {
    const bot = getBot(req);
    res.json({ ok: true, mt5: bot?.getMissionState?.().mt5 || {}, assistant: bot?.getMissionState?.().assistant || {} });
  });

  app.post('/api/assistant/note', authMiddleware, (req, res) => {
    const bot = getBot(req);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const { text } = req.body || {};
    const missionState = bot.executeOverseerCommand('save_assistant_note', { text: String(text || '').trim() });
    broadcast(req, 'mission_state', missionState);
    res.json({ ok: true, missionState });
  });

  app.get('/api/experiments', authMiddleware, (req, res) => {
    const snapshot = getSnapshot(req);
    const { insights } = runAi(snapshot);
    res.json({
      ok: true,
      regime: insights.regime,
      experiments: [
        { id: 'arena-exp-1', title: 'Cooldown Stress Test', action: 'Raise cooldown by 20% for 10 trades.' },
        { id: 'arena-exp-2', title: 'Digit Barrier Validation', action: 'Increase digit barrier threshold for one session.' }
      ]
    });
  });
}

module.exports = { installOpenClawJarvisRoutes };
