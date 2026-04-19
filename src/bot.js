// ---------------------------------------------------------------
// STRATFORGE ARENA - Bot Engine
// Handles: Rise/Fall, Over/Under, Digits Lab
// ---------------------------------------------------------------

const WebSocket = require('ws');
const { PRESETS, AUTO_EDGE_VARIANTS } = require('./strategies');
const { DEFAULT_SMC_SETTINGS, mergeSmcSettings, buildSmcSignal, buildTrailingPlan } = require('./smc-engine');
const { Mt5ExecutionService } = require('./mt5-execution-service');
const { computeStrategySignal } = require('./strategy-engine');
const { evaluateRiskGate } = require('./risk-manager');
const { assessRegime } = require('./regime-filter');
const { reviewLosses } = require('./loss-review');
const { suggestAdaptivePatch } = require('./adaptive-presets');

const DERIV_WS_URL = 'wss://ws.binaryws.com/websockets/v3?app_id=1089';
const EDGE_REVIEW_WINDOW = 5;
const PENDING_ORDER_TIMEOUT_MS = 15000;
const SETTLED_TRACK_LIMIT = 250;
const MIN_STAKE = Math.max(0.35, Number(process.env.MIN_STAKE || 0.35));
const ACCUMULATOR_MIN_STAKE = Math.max(1, Number(process.env.ACCUMULATOR_MIN_STAKE || 1));


const MANUAL_LOCKABLE_SETTING_PATHS = [
  'stakeAmount',
  'maxStake',
  'duration',
  'durationUnit',
  'stopLossPct',
  'takeProfitPct',
  'maxLossStreak',
  'maxTradesPerSession',
  'winMultiplier',
  'lossMultiplier',
  'cooldownMs',
  'dailyLossPct',
  'maxOpenTrades',
  'entryFilter.minSampleSize',
  'entryFilter.thresholds.50',
  'entryFilter.thresholds.100'
];

function hasOwn(source, key) {
  return Object.prototype.hasOwnProperty.call(source || {}, key);
}

function getValueAtPath(source, path) {
  return String(path || '').split('.').reduce((acc, part) => {
    if (acc === null || acc === undefined) return undefined;
    return acc[part];
  }, source);
}

function setValueAtPath(target, path, value) {
  const parts = String(path || '').split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[parts[parts.length - 1]] = value;
}

function deleteValueAtPath(target, path) {
  const parts = String(path || '').split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor = cursor?.[parts[i]];
    if (!cursor || typeof cursor !== 'object') return;
  }
  if (cursor && typeof cursor === 'object') delete cursor[parts[parts.length - 1]];
}

function pruneEmptyBranches(target) {
  if (!target || typeof target !== 'object') return target;
  for (const key of Object.keys(target)) {
    const value = target[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      pruneEmptyBranches(value);
      if (!Object.keys(value).length) delete target[key];
    }
  }
  return target;
}

function collectManualLocksFromPatch(patch = {}, allowedPaths = MANUAL_LOCKABLE_SETTING_PATHS) {
  const locks = [];
  for (const path of allowedPaths) {
    const value = getValueAtPath(patch, path);
    if (value !== undefined) locks.push(path);
  }
  return locks;
}

function stripProtectedSettings(patch = {}, locks = new Set()) {
  const next = JSON.parse(JSON.stringify(patch || {}));
  for (const path of locks || []) deleteValueAtPath(next, path);
  return pruneEmptyBranches(next);
}

const MARKETS = {
  R_10: 'Volatility 10',
  R_25: 'Volatility 25',
  R_50: 'Volatility 50',
  R_75: 'Volatility 75',
  R_100: 'Volatility 100',
  '1HZ10V': 'Volatility 10 (1s)',
  '1HZ25V': 'Volatility 25 (1s)',
  '1HZ50V': 'Volatility 50 (1s)',
  '1HZ75V': 'Volatility 75 (1s)',
  '1HZ100V': 'Volatility 100 (1s)'
};

function composeSettings(base = {}, ...layers) {
  const result = {
    ...(base || {}),
    entryFilter: {
      ...((base || {}).entryFilter || {}),
      thresholds: {
        ...((((base || {}).entryFilter || {}).thresholds || {}))
      }
    }
  };

  for (const layer of layers) {
    if (!layer) continue;
    const next = {
      ...layer,
      entryFilter: {
        ...(result.entryFilter || {}),
        ...(layer.entryFilter || {}),
        thresholds: {
          ...((result.entryFilter || {}).thresholds || {}),
          ...(((layer.entryFilter || {}).thresholds || {}))
        }
      }
    };

    Object.assign(result, next);
  }

  if (!Object.keys(result.entryFilter || {}).length) delete result.entryFilter;
  return result;
}

function clampStake(value, fallback = MIN_STAKE) {
  const n = Number(value);
  if (!Number.isFinite(n)) return Number(fallback || MIN_STAKE);
  return Math.max(MIN_STAKE, Number(n.toFixed(2)));
}

function minStakeForMode(mode) {
  return mode === 'accumulator' ? ACCUMULATOR_MIN_STAKE : MIN_STAKE;
}

function clampStakeForMode(mode, value, fallback) {
  const min = minStakeForMode(mode);
  const n = Number(value);
  if (!Number.isFinite(n)) return Math.max(min, Number(fallback ?? min));
  return Math.max(min, Number(n.toFixed(2)));
}


function normalizeOptionalNumber(value) {
  if (value === '' || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSettingsPatch(patch = {}) {
  const next = { ...patch };
  const entryFilter = { ...(patch.entryFilter || {}) };
  const thresholds = { ...(entryFilter.thresholds || {}) };

  if (patch.bias50Threshold !== undefined) thresholds[50] = patch.bias50Threshold;
  if (patch.bias100Threshold !== undefined) thresholds[100] = patch.bias100Threshold;
  if (Object.keys(thresholds).length) entryFilter.thresholds = thresholds;
  if (patch.minSampleSize !== undefined) entryFilter.minSampleSize = patch.minSampleSize;

  delete next.bias50Threshold;
  delete next.bias100Threshold;
  delete next.minSampleSize;

  if (Object.keys(entryFilter).length) next.entryFilter = entryFilter;
  return next;
}

class DerivBot {
  constructor(userId, broadcast, options = {}) {
    this.userId = userId;
    this.broadcast = broadcast;
    this.userRole = options.role || 'user';
    this.username = options.username || userId;
    const initialMt5Config = options.mt5Config || {};
    const initialArenaProfile = options.arenaProfile || {};

    // Deriv connection
    this.ws = null;
    this.token = null;
    this.connected = false;
    this.authorized = false;
    this._manualDisconnect = false;
    this._resumeAfterReconnect = false;
    this._reconnectTimer = null;
    this._authTimer = null;
    this._ticksActive = false;

    // Session state
    this.running = false;
    this.status = 'ready';
    this.market = initialArenaProfile.market || 'R_25';
    this.manualMarketOverride = Boolean(initialArenaProfile.manualMarketOverride);
    this.manualModeOverride = Boolean(initialArenaProfile.manualModeOverride);
    this.mode = initialArenaProfile.mode || 'digits';
    this.accumulator = { enabled: false, stepPct: 0.35, targetPct: 2.0, notes: 'Accumulator board ready' };
    this.selectedPreset = initialArenaProfile.preset || 'balanced';
    this.preset = initialArenaProfile.preset || 'balanced';
    this.settings = {};
    this.userSettings = composeSettings({}, initialArenaProfile.userSettings || {});
    this.lockedSettingPaths = new Set(Array.isArray(initialArenaProfile.lockedSettingPaths)
      ? initialArenaProfile.lockedSettingPaths
      : collectManualLocksFromPatch(initialArenaProfile.userSettings || {}));

    // Stats
    this.balance = 0;
    this.sessionStartBalance = 0;
    this.sessionStartedAt = Date.now();
    this.sessionPnl = 0;
    this.peakPnl = 0;
    this.trades = 0;
    this.wins = 0;
    this.losses = 0;
    this.lossStreak = 0;
    this.currentStake = MIN_STAKE;
    this.tradeHistory = [];

    // XP / Level system
    this.xp = 0;
    this.level = 1;

    // Tick / digit buffers
    this.ticks = [];
    this.digits = [];
    this.candles = [];

    // Pending / open orders
    this.pendingBuy = false;
    this.openContract = null;
    this._pendingProposalContext = null;
    this._pendingBuyTimer = null;
    this._contractMeta = new Map();
    this._settledContracts = new Set();
    this._settledOrder = [];

    // Cooldown
    this._lastTradeTime = 0;
    this._differsRotationIndex = 0;

    // Auto-edge session
    this.autoEdgeEnabled = initialArenaProfile.autoEdgeEnabled !== undefined ? Boolean(initialArenaProfile.autoEdgeEnabled) : true;
    this._edgeVariantIndex = 0;
    this._edgeSession = this._freshEdgeSession();

    this.overseer = {
      mode: 'assist',
      autonomyEnabled: true,
      tradingLock: false,
      lastAction: 'Monitoring live session',
      lastDecisionAt: null,
      lastSeenAt: Date.now(),
      lastAutonomousUpdateAt: 0,
      notices: [],
      researchMode: false,
      researchStartedAt: 0,
      researchDeadlineAt: 0,
      researchPhase: 'idle',
      autonomousSummary: 'Overseer is watching the arena and ready to act.'
    };
    this.agents = this._createDefaultAgents();
    this.missions = this._buildDefaultMissions();
    this._overseerPulseTimer = setInterval(() => this._runOverseerPulse(), 5000);
    this.mt5 = {
      venueEnabled: false,
      terminalConnected: false,
      activeSymbol: 'XAUUSD',
      watchlist: ['XAUUSD', 'Volatility 75 Index', 'Volatility 100 Index', 'Crash 500 Index', 'Boom 500 Index'],
      favorites: ['XAUUSD', 'Volatility 75 Index', 'Volatility 100 Index', 'Crash 500 Index', 'Boom 500 Index', 'Gold Basket'],
      catalog: this._buildMt5Catalog(),
      style: 'SMC',
      sessionBias: 'structure_wait',
      lastRecommendation: 'Wait for BOS / CHoCH confirmation before routing MT5 execution.',
      bridgeStatus: 'hooks_ready',
      smc: {
        breakoutMode: true,
        retracementMode: true,
        useKillZones: true,
        useLiquidityTP: true,
        allowLongs: true,
        allowShorts: true,
        venue: 'Deriv MT5'
      },
      positions: [],
      liveTradingEnabled: false,
      bridgeUrl: initialMt5Config.bridgeUrl || process.env.STRATFORGE_MT5_API || process.env.MT5_BRIDGE_URL || 'http://104.238.214.215:9000',
      bridgeConnected: false,
      accountLogin: initialMt5Config.login || '',
      accountPassword: initialMt5Config.password || '',
      accountServer: initialMt5Config.server || '',
      copyTrading: {
        followAdmin: Boolean(initialMt5Config.followAdmin),
        mirrorAdminTrades: Boolean(initialMt5Config.mirrorAdminTrades),
        riskMultiplier: Math.max(0.1, Number(initialMt5Config.riskMultiplier || 1)),
        sameAsAdmin: Boolean(initialMt5Config.sameAsAdmin),
        lastAdminSyncAt: 0,
        masterUserId: 'admin'
      },
      liveExecutionNote: 'Bridge hooks ready. Connect a real MT5 bridge service to enable live execution.',
      activities: [],
      lastTradeEvent: null,
      overseerTrailStatus: 'Idle',
      lastSyncError: ''
    };
    this.overseerDiagnostics = {
      regime: null,
      riskGate: null,
      lossReview: null,
      adaptivePatch: null,
      qualityScore: 0,
      modeScorecard: [],
      lastOptimization: null,
    };
    this.mt5.venueEnabled = Boolean(initialMt5Config.enabled);
    this.mt5.liveTradingEnabled = Boolean(initialMt5Config.liveTradingEnabled);
    this.mt5.watchlist = Array.isArray(initialMt5Config.allowedSymbols) && initialMt5Config.allowedSymbols.length ? initialMt5Config.allowedSymbols.slice(0, 20) : this.mt5.watchlist;
    this.mt5.smcSettings = mergeSmcSettings(DEFAULT_SMC_SETTINGS, initialMt5Config.smcSettings || {});
    this.mt5.pendingSignal = null;
    this.mt5.lastSignalAt = 0;
    this.mt5.lastSignalKey = '';
    this.mt5.lastEventAt = 0;
    this.mt5.trailing = { enabled: true, lastTrailAt: 0, activeTickets: {} };
    this.mt5.latestEvent = null;
    this.mt5Execution = new Mt5ExecutionService({
      userId: this.userId,
      logger: (msg) => this.log(msg),
      eventSink: (event) => this._handleMt5Event(event)
    });

    this.assistant = {
      mode: 'assistant',
      notes: [],
      reminders: [],
      lastReplyStyle: 'helpful',
      persona: 'Overseer'
    };

    this._selectEdgeVariant(this._findVariantIndex(this.mode, this.selectedPreset), {
      emit: false,
      reason: 'init',
      resetStake: true,
      resetEdgeSession: true
    });
  }

  // ----- Strategy / settings -----------------------------------
  _getModeVariants() {
    return AUTO_EDGE_VARIANTS[this.mode] || [];
  }

  _findVariantIndex(mode, preset) {
    const variants = AUTO_EDGE_VARIANTS[mode] || [];
    const index = variants.findIndex((variant) => variant.preset === preset);
    return index >= 0 ? index : 0;
  }

  _getActiveVariant() {
    if (!this.autoEdgeEnabled) return null;
    const variants = this._getModeVariants();
    return variants[this._edgeVariantIndex] || null;
  }

  _getEdgeLabel() {
    const variant = this._getActiveVariant();
    if (variant?.label) return variant.label;
    return PRESETS[this.mode]?.[this.preset]?.name || this.preset;
  }

  _freshEdgeSession() {
    return {
      trades: 0,
      wins: 0,
      losses: 0,
      pnl: 0,
      startedAt: Date.now()
    };
  }

  _edgeSnapshot() {
    return {
      label: this._getEdgeLabel(),
      trades: this._edgeSession.trades,
      wins: this._edgeSession.wins,
      losses: this._edgeSession.losses,
      pnl: this._edgeSession.pnl,
      startedAt: this._edgeSession.startedAt
    };
  }

  _selectEdgeVariant(index, options = {}) {
    const {
      emit = true,
      reason = 'manual',
      resetStake = true,
      resetEdgeSession = true
    } = options;

    const variants = this._getModeVariants();
    const safeIndex = variants.length ? ((index % variants.length) + variants.length) % variants.length : 0;
    const variant = this.autoEdgeEnabled
      ? (variants[safeIndex] || { preset: this.selectedPreset, overrides: {} })
      : null;
    const activePreset = variant?.preset || this.selectedPreset;
    const presetConfig = PRESETS[this.mode]?.[activePreset];
    if (!presetConfig) return;

    const modeScopedUserSettings = JSON.parse(JSON.stringify(this.userSettings || {}));
    if (modeScopedUserSettings.entryFilter) {
      delete modeScopedUserSettings.entryFilter.type;
    }

    this._edgeVariantIndex = safeIndex;
    this.preset = activePreset;
    this.settings = composeSettings(presetConfig, variant?.overrides || {}, modeScopedUserSettings);
    if (presetConfig.entryFilter?.type) {
      this.settings.entryFilter = {
        ...(this.settings.entryFilter || {}),
        type: presetConfig.entryFilter.type
      };
    }

    if (resetStake || !this.currentStake) {
      this.currentStake = clampStakeForMode(this.mode, this.settings.stakeAmount ?? presetConfig.stakeAmount ?? minStakeForMode(this.mode), minStakeForMode(this.mode));
    }

    if (resetEdgeSession) {
      this._edgeSession = this._freshEdgeSession();
    }

    if (emit) {
      this.emit('settings_applied', {
        mode: this.mode,
        preset: this.preset,
        settings: this.settings,
        edgeLabel: this._getEdgeLabel(),
        reason,
        autoEdge: this.autoEdgeEnabled
      });
    }
  }

  _rotateEdge(reason) {
    if (!this.autoEdgeEnabled) {
      this._edgeSession = this._freshEdgeSession();
      return;
    }

    const variants = this._getModeVariants();
    if (variants.length < 2) {
      this._edgeSession = this._freshEdgeSession();
      return;
    }

    const previousLabel = this._getEdgeLabel();
    const nextIndex = (this._edgeVariantIndex + 1) % variants.length;
    this._selectEdgeVariant(nextIndex, {
      emit: true,
      reason: 'auto-rotate',
      resetStake: true,
      resetEdgeSession: true
    });

    this.log(`Auto edge rotated from ${previousLabel} to ${this._getEdgeLabel()} (${reason})`);
  }

  _trackEdgeResult(won, profit) {
    if (!this.autoEdgeEnabled) return;

    this._edgeSession.trades += 1;
    this._edgeSession.pnl += profit;
    if (won) this._edgeSession.wins += 1;
    else this._edgeSession.losses += 1;

    const { trades, wins, losses, pnl } = this._edgeSession;
    const earlyRotate = losses >= 2 && pnl <= 0;
    const reviewWindowHit = trades >= EDGE_REVIEW_WINDOW;
    if (!earlyRotate && !reviewWindowHit) return;

    const shouldRotate = pnl <= 0 || wins < losses;
    if (shouldRotate) {
      this._rotateEdge(`${trades} settled trades | ${wins}W/${losses}L | P&L ${pnl.toFixed(2)}`);
      return;
    }

    this._edgeSession = this._freshEdgeSession();
  }

  updateSettings(patch = {}, options = {}) {
    const normalized = normalizeSettingsPatch(patch);
    const isManual = options.manual !== false;
    if (normalized.stakeAmount !== undefined && normalized.stakeAmount !== null) normalized.stakeAmount = clampStakeForMode(this.mode, normalized.stakeAmount, minStakeForMode(this.mode));

    const optionalKeys = ['maxTradesPerSession', 'cooldownMs', 'stopLossPct', 'takeProfitPct', 'maxLossStreak', 'dailyLossPct', 'maxOpenTrades'];
    for (const key of optionalKeys) {
      if (Object.prototype.hasOwnProperty.call(normalized, key)) {
        normalized[key] = normalizeOptionalNumber(normalized[key]);
      }
    }

    if (normalized.entryFilter) {
      for (const [k, v] of Object.entries(normalized.entryFilter)) {
        if (v === '' || Number.isNaN(v)) normalized.entryFilter[k] = null;
      }
      if (normalized.entryFilter.thresholds) {
        for (const [k, v] of Object.entries(normalized.entryFilter.thresholds)) {
          normalized.entryFilter.thresholds[k] = normalizeOptionalNumber(v);
        }
      }
    }

    if (isManual) {
      for (const path of collectManualLocksFromPatch(normalized)) {
        this.lockedSettingPaths.add(path);
      }
    }

    const effectivePatch = isManual ? normalized : stripProtectedSettings(normalized, this.lockedSettingPaths);
    if (!Object.keys(effectivePatch).length) return;

    this.userSettings = composeSettings(this.userSettings, effectivePatch);
    this._selectEdgeVariant(this._edgeVariantIndex, {
      emit: false,
      reason: options.reason || 'settings-updated',
      resetStake: effectivePatch.stakeAmount !== undefined,
      resetEdgeSession: false
    });

    this.emit('settings_applied', {
      mode: this.mode,
      preset: this.preset,
      settings: this.settings,
      edgeLabel: this._getEdgeLabel(),
      reason: options.reason || 'settings-updated',
      autoEdge: this.autoEdgeEnabled
    });
  }

  updateIndicatorSettings(patch = {}) {
    const mode = patch.mode || this.mode;
    const next = { ...patch };
    delete next.mode;
    delete next.preset;

    const entryFilter = { ...(this.settings.entryFilter || {}) };

    if (mode === 'rise_fall') {
      entryFilter.type = entryFilter.type || 'ema_cross';
      if (next.fastPeriod !== undefined) entryFilter.fastPeriod = normalizeOptionalNumber(next.fastPeriod) ?? entryFilter.fastPeriod ?? 10;
      if (next.slowPeriod !== undefined) entryFilter.slowPeriod = normalizeOptionalNumber(next.slowPeriod) ?? entryFilter.slowPeriod ?? 20;
      if (next.minTicksConfirm !== undefined) entryFilter.minTicksConfirm = normalizeOptionalNumber(next.minTicksConfirm) ?? null;
      if (next.emaTrendFloor !== undefined) entryFilter.emaTrendFloor = normalizeOptionalNumber(next.emaTrendFloor);
      if (next.rsiPeriod !== undefined) entryFilter.rsiPeriod = normalizeOptionalNumber(next.rsiPeriod);
      if (next.rsiLongFloor !== undefined) entryFilter.rsiLongFloor = normalizeOptionalNumber(next.rsiLongFloor);
      if (next.rsiShortCeil !== undefined) entryFilter.rsiShortCeil = normalizeOptionalNumber(next.rsiShortCeil);
      if (next.volatilityGuardPct !== undefined) entryFilter.volatilityGuardPct = normalizeOptionalNumber(next.volatilityGuardPct);
      if (next.bollingerStdDev !== undefined) entryFilter.stdDev = normalizeOptionalNumber(next.bollingerStdDev) ?? entryFilter.stdDev ?? 2;
    }

    if (mode === 'over_under') {
      entryFilter.type = 'digit_histogram';
      if (next.window !== undefined) entryFilter.window = normalizeOptionalNumber(next.window) ?? null;
      if (next.minBiasPct !== undefined) entryFilter.minBiasPct = normalizeOptionalNumber(next.minBiasPct) ?? null;
      if (next.overBarrier !== undefined) entryFilter.overBarrier = normalizeOptionalNumber(next.overBarrier) ?? 4;
      if (next.underBarrier !== undefined) entryFilter.underBarrier = normalizeOptionalNumber(next.underBarrier) ?? 5;
      if (next.recentStreakVeto !== undefined) entryFilter.recentStreakVeto = normalizeOptionalNumber(next.recentStreakVeto);
      if (next.qualityWindow !== undefined) entryFilter.qualityWindow = normalizeOptionalNumber(next.qualityWindow);
      if (next.biasSide) this.settings.tradeType = next.biasSide === 'under' ? 'DIGITUNDER' : next.biasSide === 'over' ? 'DIGITOVER' : 'AUTO_DIGIT';
    }

    if (mode === 'digits') {
      entryFilter.type = 'even_odd_bias';
      if (Array.isArray(next.windows)) entryFilter.windows = next.windows.filter(Boolean).map(Number);
      entryFilter.thresholds = { ...(entryFilter.thresholds || {}) };
      if (next.thresholds && typeof next.thresholds === 'object') {
        for (const [k, v] of Object.entries(next.thresholds)) entryFilter.thresholds[k] = normalizeOptionalNumber(v);
      }
      if (next.minSampleSize !== undefined) entryFilter.minSampleSize = normalizeOptionalNumber(next.minSampleSize);
      if (next.biasMode) entryFilter.biasMode = next.biasMode;
      if (next.streakVeto !== undefined) entryFilter.streakVeto = normalizeOptionalNumber(next.streakVeto);
      if (next.minEdgePct !== undefined) entryFilter.minEdgePct = normalizeOptionalNumber(next.minEdgePct);
    }

    if (mode === 'accumulator') {
      entryFilter.type = 'accumulator_watch';
      if (next.minimumTicks !== undefined) entryFilter.minimumTicks = normalizeOptionalNumber(next.minimumTicks);
      if (next.minTrendBiasPct !== undefined) entryFilter.minTrendBiasPct = normalizeOptionalNumber(next.minTrendBiasPct);
      if (next.stepPct !== undefined) entryFilter.stepPct = normalizeOptionalNumber(next.stepPct);
      if (next.targetPct !== undefined) entryFilter.targetPct = normalizeOptionalNumber(next.targetPct);
      if (next.pullbackPct !== undefined) entryFilter.pullbackPct = normalizeOptionalNumber(next.pullbackPct);
      if (next.emaFast !== undefined) entryFilter.emaFast = normalizeOptionalNumber(next.emaFast);
      if (next.emaSlow !== undefined) entryFilter.emaSlow = normalizeOptionalNumber(next.emaSlow);
      if (next.maxRealizedVolPct !== undefined) entryFilter.maxRealizedVolPct = normalizeOptionalNumber(next.maxRealizedVolPct);
      this.accumulator = {
        ...this.accumulator,
        enabled: next.enabled !== undefined ? next.enabled !== false : this.accumulator.enabled,
        stepPct: normalizeOptionalNumber(next.stepPct) ?? this.accumulator.stepPct,
        targetPct: normalizeOptionalNumber(next.targetPct) ?? this.accumulator.targetPct,
        notes: next.notes || this.accumulator.notes
      };
    }

    this.updateSettings({ entryFilter });
    this.overseer.lastAction = `Overseer tuned ${mode.replace('_', '/')} indicators`;
    this._pushNotice(this.overseer.lastAction, 'info');
  }

  setMode(mode, preset, options = {}) {
    this.mode = mode || this.mode;
    this.selectedPreset = preset || this.selectedPreset;
    if (this.userSettings?.entryFilter?.type) {
      delete this.userSettings.entryFilter.type;
    }
    if (options.manual !== false) this.manualModeOverride = true;
    this._selectEdgeVariant(this._findVariantIndex(this.mode, this.selectedPreset), {
      emit: true,
      reason: 'mode-changed',
      resetStake: true,
      resetEdgeSession: true
    });
  }

  setMarket(market, options = {}) {
    if (!market || market === this.market) return;
    this.market = market;
    if (options.manual !== false) this.manualMarketOverride = true;

    this.ticks = [];
    this.digits = [];
    this.candles = [];

    if (this.authorized && this._ticksActive) {
      this._send({ forget_all: 'ticks' });
      this._send({ forget_all: 'candles' });
      this.startTicks({ silent: true });
    }

    this.log(`Market switched to ${market}`);
    this.emit('market_changed', { market });
  }

  setAutoEdge(enabled) {
    const next = enabled !== false;
    if (this.autoEdgeEnabled === next) return;

    this.autoEdgeEnabled = next;
    this._selectEdgeVariant(this._findVariantIndex(this.mode, this.selectedPreset), {
      emit: true,
      reason: next ? 'auto-edge-enabled' : 'auto-edge-disabled',
      resetStake: true,
      resetEdgeSession: true
    });

    this.log(`Auto edge ${next ? 'enabled' : 'disabled'}`);
  }

  // ----- Connection --------------------------------------------
  _clearReconnectTimer() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  _clearAuthTimer() {
    if (this._authTimer) {
      clearTimeout(this._authTimer);
      this._authTimer = null;
    }
  }

  _failAuthorization(message, code, socket = this.ws) {
    const hints = {
      InvalidToken: 'Check that the token is valid and copied fully from Deriv.',
      AuthorizationRequired: 'Make sure the token has the required permissions.'
    };
    const suffix = hints[code] ? ` ${hints[code]}` : '';

    this.connected = false;
    this.authorized = false;
    this._resumeAfterReconnect = false;
    this._clearReconnectTimer();
    this._clearAuthTimer();
    this._clearPendingTrade();

    if (this.ws === socket) this.ws = null;
    if (socket) {
      try { socket.close(); } catch (_) {}
    }

    this.emit('connection', { connected: false });
    this.emit('error', { message: `${message}${suffix}`, code });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer || !this.token || this._manualDisconnect) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(this.token);
    }, 3000);
  }

  connect(token) {
    if (token) this.token = token;
    if (!this.token) return;

    this._manualDisconnect = false;
    this._clearReconnectTimer();

    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }

    const socket = new WebSocket(DERIV_WS_URL);
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket) return;
      this.connected = true;
      this.emit('connection', { connected: true });
      this._send({ authorize: this.token });
      this._clearAuthTimer();
      this._authTimer = setTimeout(() => {
        if (this.ws !== socket || this.authorized) return;
        this._failAuthorization('Authorization timed out.', 'AuthorizeTimeout', socket);
      }, 10000);
    });

    socket.on('message', (raw) => {
      if (this.ws !== socket) return;
      try {
        this._handleMessage(JSON.parse(raw.toString()));
      } catch (error) {
        console.error('[Bot] JSON parse error:', error.message);
      }
    });

    socket.on('close', () => {
      if (this.ws !== socket) return;
      const shouldResume = this.running || this._resumeAfterReconnect;

      this.connected = false;
      this.authorized = false;
      this.ws = null;
      this._clearAuthTimer();
      this._clearPendingTrade();
      this.emit('connection', { connected: false });

      if (!this._manualDisconnect && this.status !== 'stopped') {
        this._resumeAfterReconnect = shouldResume;
        this._setStatus('ready');
        this._scheduleReconnect();
      }
    });

    socket.on('error', (err) => {
      if (this.ws !== socket) return;
      this.emit('error', { message: err.message });
    });
  }

  disconnect() {
    this._manualDisconnect = true;
    this._resumeAfterReconnect = false;
    this._ticksActive = false;
    this._clearReconnectTimer();
    this._clearAuthTimer();
    this._clearPendingTrade();

    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }

    this.connected = false;
    this.authorized = false;
    this.emit('connection', { connected: false });
    this._setStatus('stopped');
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  // ----- Message router ----------------------------------------
  _handleMessage(msg) {
    if (msg.error) {
      if (msg.msg_type === 'authorize' || msg.echo_req?.authorize) {
        this._failAuthorization(msg.error.message, msg.error.code);
        return;
      }
      if (this.pendingBuy) this._clearPendingTrade();
      this.emit('error', { message: msg.error.message, code: msg.error.code });
      return;
    }

    switch (msg.msg_type) {
      case 'authorize':
        this._onAuthorize(msg.authorize);
        break;
      case 'balance':
        this._onBalance(msg.balance);
        break;
      case 'tick':
        this._onTick(msg.tick);
        break;
      case 'ohlc':
        this._onCandle(msg.ohlc);
        break;
      case 'buy':
        this._onBuy(msg.buy);
        break;
      case 'proposal':
        this._onProposal(msg.proposal);
        break;
      case 'proposal_open_contract':
        this._onContractUpdate(msg.proposal_open_contract);
        break;
      case 'transaction':
        this._onTransaction(msg.transaction);
        break;
      default:
        break;
    }
  }

  _onAuthorize(data) {
    this._clearAuthTimer();
    this.authorized = true;
    this.balance = parseFloat(data.balance);
    if (!this.sessionStartBalance) this.sessionStartBalance = this.balance;

    this.emit('authorized', {
      balance: this.balance,
      loginid: data.loginid,
      currency: data.currency
    });

    this._send({ balance: 1, subscribe: 1 });
    this._send({ transaction: 1, subscribe: 1 });

    if (this._ticksActive) this.startTicks({ silent: true });
    if (this.openContract) {
      this._send({ proposal_open_contract: 1, contract_id: this.openContract, subscribe: 1 });
    }

    if (this._resumeAfterReconnect) {
      this._resumeAfterReconnect = false;
      this.start({ resume: true });
    } else if (this.status !== 'stopped') {
      this._setStatus('ready');
    }

    this.log('Connected and authorized');
  }

  _onBalance(data) {
    this.balance = parseFloat(data.balance);
    if (!this.sessionStartBalance) this.sessionStartBalance = this.balance;
    this.emit('balance', { balance: this.balance });
  }

  _onTransaction(data) {
    if (data.action !== 'sell') return;
    const buyPrice = Number(data.buy_price ?? data.buyPrice ?? 0);
    const sellPrice = Number(data.sell_price ?? data.sellPrice ?? data.amount ?? data.payout ?? 0);
    const explicitProfit = Number(data.profit);
    const profit = Number.isFinite(explicitProfit)
      ? explicitProfit
      : (Number.isFinite(sellPrice) && Number.isFinite(buyPrice) ? sellPrice - buyPrice : NaN);
    const status = String(data.contract_status || data.result || data.status || '').toLowerCase();
    const isWon = data.is_won === true || data.is_won === 1 || status === 'won' || (Number.isFinite(profit) ? profit > 0 : sellPrice > buyPrice);

    this._finalizeContractResult(data.contract_id, {
      contract_id: data.contract_id,
      buy_price: buyPrice,
      sell_price: sellPrice,
      payout: Number.isFinite(sellPrice) ? sellPrice : undefined,
      profit,
      contract_status: isWon ? 'won' : 'lost',
      is_won: isWon,
      result: data.result,
      outcome: data.outcome
    });
  }

  // ----- Ticks --------------------------------------------------
  startTicks(options = {}) {
    const { silent = false } = options;
    if (!this.authorized) {
      if (!silent) this.log('Not authorized');
      return;
    }

    this._ticksActive = true;
    this._send({ forget_all: 'ticks' });
    this._send({ forget_all: 'candles' });
    this._send({ ticks: this.market, subscribe: 1 });
    this._send({ ticks_history: this.market, count: 500, end: 'latest', style: 'ticks', subscribe: 1 });
    this._send({ ticks_history: this.market, count: 100, end: 'latest', style: 'candles', granularity: 60, subscribe: 1 });

    if (!silent) this.log(`Subscribed to ${this.market} ticks`);
  }

  stopTicks(options = {}) {
    const { preserveIntent = false } = options;
    if (!preserveIntent) this._ticksActive = false;
    this._send({ forget_all: 'ticks' });
    this._send({ forget_all: 'candles' });
  }

  _onTick(tick) {
    const price = parseFloat(tick.quote);
    const lastDigit = parseInt(tick.quote.toString().slice(-1), 10);

    this.ticks.push(price);
    if (this.ticks.length > 500) this.ticks.shift();

    this.digits.push(lastDigit);
    if (this.digits.length > 500) this.digits.shift();

    const analyzerData = this._computeAnalyzer();
    this.emit('tick', { price, lastDigit, analyzerData });

    if (this.running && !this.pendingBuy) {
      this._evaluateEntry(price, lastDigit, analyzerData);
    }
  }

  _onCandle(ohlc) {
    const candle = {
      open: parseFloat(ohlc.open),
      high: parseFloat(ohlc.high),
      low: parseFloat(ohlc.low),
      close: parseFloat(ohlc.close),
      time: ohlc.epoch
    };

    const last = this.candles[this.candles.length - 1];
    if (last && last.time === candle.time) {
      this.candles[this.candles.length - 1] = candle;
    } else {
      this.candles.push(candle);
      if (this.candles.length > 200) this.candles.shift();
    }

    this.emit('candle', candle);
    if (this.running && this.mt5 && this.mt5.venueEnabled) {
      this._evaluateSmcVenue().catch((error) => this.log(`SMC evaluation failed: ${error.message}`));
    }
  }

  // ----- Analyzer ----------------------------------------------
  _getAnalyzerRequirement() {
    const filter = this.settings?.entryFilter || {};

    if (this.mode === 'digits') {
      if (filter.type === 'hot_digit_cluster') {
        return { available: this.digits.length, requiredSample: normalizeOptionalNumber(filter.minSampleSize) ?? normalizeOptionalNumber(filter.window) ?? 10 };
      }
      if (filter.type === 'differs_rotation') {
        return { available: this.digits.length, requiredSample: normalizeOptionalNumber(filter.minSampleSize) ?? normalizeOptionalNumber(filter.tickWindow) ?? 10 };
      }
      const windows = filter.windows || [50];
      const numericWindows = windows.map((w) => Number(w)).filter(Number.isFinite);
      const requiredSample = normalizeOptionalNumber(filter.minSampleSize) ?? Math.max(...numericWindows, 50);
      return {
        available: this.digits.length,
        requiredSample
      };
    }

    if (this.mode === 'over_under') {
      const window = normalizeOptionalNumber(filter.window) ?? (filter.type === 'hit_and_run' ? 6 : filter.type === 'under2_reversal' ? 20 : 50);
      return {
        available: this.digits.length,
        requiredSample: normalizeOptionalNumber(filter.minSampleSize) ?? window
      };
    }

    if (this.mode === 'accumulator') {
      const minimumTicks = normalizeOptionalNumber(filter.minimumTicks) ?? 100;
      return { available: this.ticks.length, requiredSample: minimumTicks };
    }

    if (this.mode === 'rise_fall') {
      if (filter.type === 'ema_cross' || filter.type === 'ema_macd_cross') {
        return {
          available: this.ticks.length,
          requiredSample: Math.max(filter.fastPeriod || 10, filter.slowPeriod || 20) + 35
        };
      }

      if (filter.type === 'bollinger_breakout' || filter.type === 'bollinger_hull_breakout') {
        return {
          available: this.ticks.length,
          requiredSample: Math.max(filter.bbPeriod || filter.period || 20, filter.hullPeriod || 14) + 20
        };
      }

      if (filter.type === 'tick_momentum' || filter.type === 'trend_pullback_continuation') {
        return {
          available: this.ticks.length,
          requiredSample: Math.max(filter.fastPeriod || 9, filter.slowPeriod || 21) + 5
        };
      }
    }

    return {
      available: this.digits.length,
      requiredSample: 50
    };
  }

  _computeAnalyzer() {
    const digits = this.digits;
    const windows = [20, 50, 100, 200];
    const { available, requiredSample } = this._getAnalyzerRequirement();
    const result = { lastDigit: digits[digits.length - 1] };

    for (const window of windows) {
      const slice = digits.slice(-window);
      if (slice.length < window) {
        result[`w${window}`] = null;
        continue;
      }

      const even = slice.filter((value) => value % 2 === 0).length;
      const odd = slice.length - even;
      const high = slice.filter((value) => value >= 5).length;
      const low = slice.length - high;

      result[`w${window}`] = {
        even,
        odd,
        high,
        low,
        total: slice.length,
        evenPct: (even / slice.length * 100).toFixed(1),
        oddPct: (odd / slice.length * 100).toFixed(1),
        highPct: (high / slice.length * 100).toFixed(1),
        lowPct: (low / slice.length * 100).toFixed(1)
      };
    }

    let streak = 0;
    let streakType = null;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      const type = digits[index] % 2 === 0 ? 'EVEN' : 'ODD';
      if (streakType === null) streakType = type;
      if (type === streakType) streak += 1;
      else break;
    }

    result.streak = streak;
    result.streakType = streakType;
    result.ready = available >= requiredSample;
    result.requiredSample = requiredSample;
    result.sample = `${available} / ${requiredSample}`;
    result.signal = result.ready
      ? this._computeSignal(result)
      : { trade: false, reason: `Waiting for ${requiredSample} ticks` };

    return result;
  }

  _computeSignal(analyzer) {
    return computeStrategySignal({
      mode: this.mode,
      settings: this.settings,
      ticks: this.ticks,
      digits: this.digits,
      candles: this.candles,
      state: {
        rotationIndex: this._differsRotationIndex || 0
      }
    });
  }

  // ----- Technical indicators ----------------------------------
  _ema(prices, period) {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((sum, value) => sum + value, 0) / period;
    for (let index = period; index < prices.length; index += 1) {
      ema = prices[index] * multiplier + ema * (1 - multiplier);
    }
    return ema;
  }

  _emaSignal(fast, slow) {
    const prices = this.ticks.slice(-Math.max(fast, slow) - 5);
    if (prices.length < slow) return null;

    const emaFast = this._ema(prices, fast);
    const emaFastPrev = this._ema(prices.slice(0, -1), fast);
    const emaSlow = this._ema(prices, slow);
    const emaSlowPrev = this._ema(prices.slice(0, -1), slow);

    if (!emaFast || !emaFastPrev || !emaSlow || !emaSlowPrev) return null;
    if (emaFastPrev <= emaSlowPrev && emaFast > emaSlow) return 'RISE';
    if (emaFastPrev >= emaSlowPrev && emaFast < emaSlow) return 'FALL';
    return null;
  }

  _bollingerSignal(period, stdDev) {
    const prices = this.ticks.slice(-period - 2);
    if (prices.length < period) return null;

    const slice = prices.slice(-period);
    const mean = slice.reduce((sum, value) => sum + value, 0) / period;
    const variance = slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / period;
    const deviation = Math.sqrt(variance);
    const lower = mean - stdDev * deviation;
    const upper = mean + stdDev * deviation;
    const last = prices[prices.length - 1];

    if (last < lower) return 'RISE';
    if (last > upper) return 'FALL';
    return null;
  }

  _momentumSignal(count) {
    const ticks = this.ticks;
    if (ticks.length < count + 1) return null;

    const recent = ticks.slice(-count - 1);
    let up = true;
    let down = true;

    for (let index = 1; index < recent.length; index += 1) {
      if (recent[index] <= recent[index - 1]) up = false;
      if (recent[index] >= recent[index - 1]) down = false;
    }

    if (up) return 'RISE';
    if (down) return 'FALL';
    return null;
  }

  _rsi(period = 14) {
    const prices = this.candles.length ? this.candles.map(c => Number(c.close)) : this.ticks;
    if (!prices || prices.length < period + 1) return null;
    let gains = 0;
    let losses = 0;
    for (let i = prices.length - period; i < prices.length; i += 1) {
      const diff = prices[i] - prices[i - 1];
      if (diff > 0) gains += diff;
      else losses -= diff;
    }
    if (losses === 0) return 100;
    const rs = (gains / period) / (losses / period || 1e-9);
    return 100 - (100 / (1 + rs));
  }

  _realizedVolPct(window = 20) {
    const prices = this.candles.length ? this.candles.map(c => Number(c.close)) : this.ticks;
    if (!prices || prices.length < window + 1) return null;
    const slice = prices.slice(-window);
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    if (!mean) return null;
    const variance = slice.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / slice.length;
    return (Math.sqrt(variance) / mean) * 100;
  }

  _recentDigitStreak() {
    if (!this.digits.length) return { digit: null, streak: 0 };
    const last = this.digits[this.digits.length - 1];
    let streak = 1;
    for (let i = this.digits.length - 2; i >= 0; i -= 1) {
      if (this.digits[i] === last) streak += 1;
      else break;
    }
    return { digit: last, streak };
  }

  // ----- Entry evaluation --------------------------------------
  _pause(reason) {
    this._clearPendingTrade();
    this._setStatus('ready');
    this.emit('pause', { reason });
  }

  _evaluateEntry(price, lastDigit, analyzer) {
    const now = Date.now();
    const regime = assessRegime({ ticks: this.ticks, digits: this.digits, candles: this.candles, mode: this.mode });
    const riskGate = evaluateRiskGate({
      stats: this._getStats(),
      settings: this.settings,
      tradeHistory: this.tradeHistory,
      currentStake: this.currentStake,
      balance: this.balance,
      sessionStartBalance: this.sessionStartBalance,
      openTrades: this.openContract ? 1 : 0,
    });
    this.overseerDiagnostics.regime = regime;
    this.overseerDiagnostics.riskGate = riskGate;

    if (regime.recommendation === 'stand_down') {
      this.overseer.lastAction = `Overseer blocked entry: chaotic regime (${(regime.volatilityPct || 0).toFixed ? regime.volatilityPct.toFixed(2) : regime.volatilityPct}% vol)`;
      return;
    }


    if (!riskGate.allow) {
      this.overseer.lastAction = `Overseer blocked entry: ${riskGate.reason}`;
      if (['daily_loss','session_stop'].includes(riskGate.code)) this.overseer.tradingLock = true;
      return;
    }

    const cooldown = normalizeOptionalNumber(this.settings.cooldownMs);
    if (cooldown !== null && now - this._lastTradeTime < cooldown) return;

    const maxLossStreak = normalizeOptionalNumber(this.settings.maxLossStreak);
    if (maxLossStreak !== null && this.lossStreak >= maxLossStreak) {
      this._pause(`Loss streak limit (${this.lossStreak}) reached`);
      return;
    }

    const maxTradesPerSession = normalizeOptionalNumber(this.settings.maxTradesPerSession);
    if (maxTradesPerSession !== null && this.trades >= maxTradesPerSession) {
      this._pause('Max trades per session reached');
      return;
    }

    const baseBalance = this.sessionStartBalance || this.balance || 0;
    const stopLossPct = normalizeOptionalNumber(this.settings.stopLossPct);
    const takeProfitPct = normalizeOptionalNumber(this.settings.takeProfitPct);
    const dailyLossPct = normalizeOptionalNumber(this.settings.dailyLossPct);
    const stopLoss = stopLossPct !== null ? (stopLossPct / 100) * baseBalance : 0;
    const takeProfit = takeProfitPct !== null ? (takeProfitPct / 100) * baseBalance : 0;
    const dailyLoss = dailyLossPct !== null ? (dailyLossPct / 100) * baseBalance : 0;

    if (dailyLoss > 0 && this.sessionPnl <= -dailyLoss) {
      this._pause(`Daily loss hit (${dailyLossPct}%)`);
      return;
    }

    if (stopLoss > 0 && this.sessionPnl <= -stopLoss) {
      this._pause(`Stop loss hit (${stopLossPct}%)`);
      return;
    }

    if (takeProfit > 0 && this.sessionPnl >= takeProfit) {
      this._pause(`Take profit hit (${takeProfitPct}%)`);
      return;
    }

    const { signal } = analyzer;
    if (!signal?.trade) return;
    if (signal.nextState && Object.prototype.hasOwnProperty.call(signal.nextState, 'rotationIndex')) {
      this._differsRotationIndex = Number(signal.nextState.rotationIndex) || 0;
    }
    this._placeTrade(signal, analyzer);
  }

  // ----- Trade placement ---------------------------------------
  _clearPendingBuyTimer() {
    if (this._pendingBuyTimer) {
      clearTimeout(this._pendingBuyTimer);
      this._pendingBuyTimer = null;
    }
  }

  _clearPendingTrade() {
    this.pendingBuy = false;
    this._pendingProposalContext = null;
    this._clearPendingBuyTimer();
  }

  _normalizeContractId(contractId) {
    if (contractId === null || contractId === undefined) return '';
    return String(contractId);
  }

  _rememberSettledContract(contractId) {
    const normalizedId = this._normalizeContractId(contractId);
    if (!normalizedId) return;
    this._settledContracts.add(normalizedId);
    this._settledOrder.push(normalizedId);
    if (this._settledOrder.length > SETTLED_TRACK_LIMIT) {
      const oldest = this._settledOrder.shift();
      this._settledContracts.delete(oldest);
    }
  }

  _placeTrade(signal, analyzer) {
    if (this.pendingBuy || !this.running) return;

    this.pendingBuy = true;
    this._lastTradeTime = Date.now();

    const stake = clampStakeForMode(this.mode, this.currentStake || this.settings.stakeAmount || minStakeForMode(this.mode), minStakeForMode(this.mode));
    const { mode, market, settings } = this;
    let contractType;
    let barrier;

    if (mode === 'rise_fall') {
      contractType = signal.direction === 'RISE' ? 'CALL' : 'PUT';
    } else if (mode === 'over_under') {
      contractType = signal.contractType || (settings.tradeType === 'DIGITUNDER' ? 'DIGITUNDER' : 'DIGITOVER');
      barrier = signal.barrier ?? settings.barrier ?? (contractType === 'DIGITUNDER' ? 5 : 4);
    } else if (mode === 'digits') {
      contractType = signal.contractType || settings.tradeType || (signal.direction === 'EVEN' ? 'DIGITEVEN' : 'DIGITODD');
      if (['DIGITMATCH', 'DIGITDIFFERS', 'DIGITOVER', 'DIGITUNDER'].includes(contractType)) {
        barrier = signal.barrier ?? settings.barrier ?? settings.predictedDigit ?? 0;
      }
    } else if (mode === 'accumulator') {
      contractType = 'ACCU';
    }

    const proposal = {
      proposal: 1,
      amount: stake.toFixed(2),
      basis: 'stake',
      contract_type: contractType,
      currency: 'USD',
      symbol: market
    };

    if (mode !== 'accumulator') {
      proposal.duration = settings.duration || 1;
      proposal.duration_unit = settings.durationUnit || 't';
    }

    if (mode === 'accumulator') {
      const growthRate = Number(signal.growthRate || settings.entryFilter?.stepPct || this.accumulator.stepPct || 0.03);
      proposal.amount = clampStakeForMode('accumulator', stake, ACCUMULATOR_MIN_STAKE).toFixed(2);
      proposal.growth_rate = Math.min(0.05, Math.max(0.01, Number(growthRate.toFixed(2))));
      const targetPct = Number(signal.targetPct || settings.entryFilter?.targetPct || this.accumulator.targetPct || 2);
      proposal.limit_order = { take_profit: Math.max(0.5, Number(targetPct.toFixed(2))) };
    }

    if (barrier !== undefined) proposal.barrier = barrier;

    this._pendingProposalContext = {
      direction: signal.direction,
      reason: signal.reason,
      stake,
      mode: this.mode,
      market: this.market,
      preset: this.preset,
      edgeLabel: this._getEdgeLabel(),
      contractType,
      barrier,
      growthRate: signal.growthRate,
      requestedAt: Date.now()
    };

    this._pendingBuyTimer = setTimeout(() => {
      if (!this.pendingBuy) return;
      this._clearPendingTrade();
      this.emit('error', { message: 'Order request timed out. Returning to standby.' });
      if (this.status !== 'stopped') this._setStatus('ready');
    }, PENDING_ORDER_TIMEOUT_MS);

    this.log(`Signal: ${signal.direction} | ${signal.reason} | Stake: $${stake.toFixed(2)}`);
    this._send(proposal);
  }

  _onProposal(data) {
    if (!this.pendingBuy || !data.id) return;
    if (!this.running) {
      this._clearPendingTrade();
      return;
    }

    this._send({ buy: data.id, price: data.ask_price });
  }

  _onBuy(data) {
    if (!this.pendingBuy || !data.contract_id) return;

    const meta = {
      ...(this._pendingProposalContext || {}),
      buyPrice: parseFloat(data.buy_price || 0),
      openedAt: Date.now()
    };

    const contractKey = this._normalizeContractId(data.contract_id);
    this.openContract = contractKey;
    this._contractMeta.set(contractKey, meta);
    this.pendingBuy = false;
    this._pendingProposalContext = null;
    this._clearPendingBuyTimer();

    this.emit('trade_opened', {
      contractId: data.contract_id,
      buyPrice: data.buy_price,
      direction: meta.direction,
      stake: meta.stake,
      preset: meta.preset,
      edgeLabel: meta.edgeLabel
    });

    this._send({ proposal_open_contract: 1, contract_id: data.contract_id, subscribe: 1 });
  }

  _onContractUpdate(data) {
    if (data.status !== 'sold' && !data.is_sold) return;
    this._finalizeContractResult(data.contract_id, data);
  }

  _deriveSettlement(data = {}, meta = {}) {
    const settlementMode = meta.mode || this.mode;
    const stakeRaw = Number(meta.stake ?? meta.buyPrice ?? data.buy_price ?? data.buyPrice ?? this.currentStake ?? this.settings.stakeAmount ?? MIN_STAKE);
    const settledStake = clampStakeForMode(
      settlementMode,
      Number.isFinite(stakeRaw) && stakeRaw > 0 ? stakeRaw : minStakeForMode(settlementMode),
      minStakeForMode(settlementMode)
    );

    const sellPriceCandidates = [data.sell_price, data.payout, data.bid_price, data.amount];
    let payout = NaN;
    for (const candidate of sellPriceCandidates) {
      const n = Number(candidate);
      if (Number.isFinite(n)) { payout = n; break; }
    }

    let profit = Number(data.profit);
    const explicitProfit = Number.isFinite(profit) ? profit : NaN;
    if (Number.isFinite(explicitProfit) && explicitProfit > 0 && explicitProfit >= settledStake) {
      if (!Number.isFinite(payout) || Math.abs(explicitProfit - payout) < 0.000001 || explicitProfit > payout) {
        payout = explicitProfit;
        profit = explicitProfit - settledStake;
      }
    }
    if (!Number.isFinite(profit)) {
      profit = Number.isFinite(payout) ? (payout - settledStake) : NaN;
    } else if (profit === 0 && Number.isFinite(payout) && payout !== settledStake) {
      profit = payout - settledStake;
    }

    const status = String(data.contract_status || data.result || data.outcome || data.status || '').toLowerCase();
    let won = null;
    if (status === 'won' || data.is_won === 1 || data.is_won === true) won = true;
    else if (status === 'lost' || data.is_won === 0 || data.is_won === false) won = false;
    else if (Number.isFinite(profit) && profit !== 0) won = profit > 0;
    else if (Number.isFinite(Number(data.sell_price)) && Number.isFinite(Number(data.buy_price))) won = Number(data.sell_price) > Number(data.buy_price);
    else if (Number.isFinite(payout)) won = payout > settledStake;

    if (!Number.isFinite(profit)) {
      profit = won === true ? Math.max(0, settledStake * 0.95) : -settledStake;
    }

    if (!Number.isFinite(payout)) {
      payout = Math.max(0, settledStake + profit);
    }

    if (won === null) won = profit > 0;
    if (!won && profit >= 0) profit = payout > settledStake ? (payout - settledStake) : -settledStake;
    if (won && profit <= 0) profit = payout > settledStake ? (payout - settledStake) : Math.max(0, settledStake * 0.95);

    payout = Math.max(0, payout);

    return { won, profit, payout, settledStake };
  }

  _finalizeContractResult(contractId, settlementData = {}) {
    const contractKey = this._normalizeContractId(contractId);
    if (!contractKey || this._settledContracts.has(contractKey)) return;

    this._rememberSettledContract(contractKey);

    const meta = this._contractMeta.get(contractKey) || {};
    this._contractMeta.delete(contractKey);
    if (this.openContract === contractKey) this.openContract = null;

    const settlement = this._deriveSettlement(settlementData, meta);
    this._recordResult(settlement.won, settlement.profit, contractKey, {
      ...meta,
      payout: settlement.payout,
      settledStake: settlement.settledStake
    });
  }

  _recordResult(won, profit, contractId, meta = {}) {
    const modeForStake = meta.mode || this.mode;
    const stakeSource = meta.stake ?? meta.settledStake ?? this.currentStake ?? this.settings.stakeAmount ?? minStakeForMode(modeForStake);
    const settledStake = clampStakeForMode(modeForStake, stakeSource, minStakeForMode(modeForStake));
    const parsedProfit = Number(profit);
    const normalizedProfit = Number.isFinite(parsedProfit)
      ? parsedProfit
      : (won ? settledStake : -settledStake);
    const payout = Math.max(0, Number.isFinite(Number(meta.payout)) ? Number(meta.payout) : (settledStake + normalizedProfit));

    this.trades += 1;
    this.sessionPnl += normalizedProfit;
    this.peakPnl = Math.max(this.peakPnl, this.sessionPnl);

    if (won) {
      this.wins += 1;
      this.lossStreak = 0;
      this._adjustStake('win');
      this._addXp(25);
    } else {
      this.losses += 1;
      this.lossStreak += 1;
      this._adjustStake('loss');
      this._addXp(5);
    }

    const tradeRecord = {
      id: contractId,
      time: Date.now(),
      mode: meta.mode || this.mode,
      market: meta.market || this.market,
      preset: meta.preset || this.preset,
      edgeLabel: meta.edgeLabel || this._getEdgeLabel(),
      direction: meta.direction || '',
      result: won ? 'won' : 'lost',
      profit: normalizedProfit,
      stake: settledStake,
      payout,
      returnAmount: payout,
      lossStreak: this.lossStreak,
      sessionPnl: this.sessionPnl,
      balance: this.balance
    };

    this.tradeHistory.unshift(tradeRecord);
    if (this.tradeHistory.length > 50) this.tradeHistory.pop();

    this.emit('trade_result', tradeRecord);
    this.emit('stats', this._getStats());

    this.log(`${won ? 'WON' : 'LOST'} | P&L: ${normalizedProfit > 0 ? '+' : normalizedProfit < 0 ? '-' : ''}$${Math.abs(normalizedProfit).toFixed(2)} | Session: ${this.sessionPnl > 0 ? '+' : this.sessionPnl < 0 ? '-' : ''}$${Math.abs(this.sessionPnl).toFixed(2)}`);

    this._syncMissionProgress();
    this._trackEdgeResult(won, normalizedProfit);
    this._maybeTriggerAutonomy();
  }

  _adjustStake(result) {
    const settings = this.settings;
    if (!settings.stakeMode || settings.stakeMode === 'fixed') return;

    if (settings.stakeMode === 'martingale') {
      this.currentStake = result === 'loss'
        ? this.currentStake * settings.lossMultiplier
        : settings.stakeAmount;
    } else if (settings.stakeMode === 'pls') {
      this.currentStake = result === 'loss'
        ? this.currentStake * settings.lossMultiplier
        : settings.stakeAmount;
    } else if (settings.stakeMode === 'anti_martingale') {
      this.currentStake = result === 'win'
        ? this.currentStake * settings.winMultiplier
        : this.currentStake * settings.lossMultiplier;
      this.currentStake = Math.max(this.currentStake, minStakeForMode(this.mode));
    }

    const byBalance = this.balance > 0 ? this.balance * 0.05 : Number.MAX_SAFE_INTEGER;
    const bySetting = settings.maxStake || Number.MAX_SAFE_INTEGER;
    const maxStake = Math.min(byBalance, bySetting);
    if (this.currentStake > maxStake) {
      this.currentStake = maxStake;
      this.log(`Stake capped at $${maxStake.toFixed(2)}`);
    }
    this.currentStake = clampStakeForMode(this.mode, this.currentStake, minStakeForMode(this.mode));
  }

  // ----- XP / Level --------------------------------------------
  _addXp(amount) {
    this.xp += amount;
    const newLevel = this._calcLevel(this.xp);
    if (newLevel > this.level) {
      this.level = newLevel;
      this.emit('level_up', {
        level: newLevel,
        name: LEVEL_NAMES[newLevel] || 'Legend',
        xp: this.xp
      });
    }

    this.emit('xp', { xp: this.xp, level: this.level });
  }

  _calcLevel(xp) {
    const thresholds = [0, 500, 1500, 3000, 6000, 12000, 25000];
    let level = 1;
    for (let index = 0; index < thresholds.length; index += 1) {
      if (xp >= thresholds[index]) level = index + 1;
    }
    return Math.min(level, 7);
  }


  _createDefaultAgents() {
    return [
      { id: 'overseer', name: 'Overseer', role: 'Command', status: 'watching' },
      { id: 'jarvis', name: 'Open Jarvis', role: 'Frontline Copilot', status: 'ready' },
      { id: 'openclaw', name: 'OpenClaw', role: 'Execution Scout', status: 'ready' },
      { id: 'risk', name: 'Risk Guardian', role: 'Risk Control', status: 'ready' },
      { id: 'strategy', name: 'Strategy Lab', role: 'Edge Research', status: 'ready' },
      { id: 'regime', name: 'Regime Agent', role: 'Market Context', status: 'ready' },
      { id: 'reviewer', name: 'Session Reviewer', role: 'Performance Review', status: 'ready' },
      { id: 'memory', name: 'Memory Curator', role: 'Pattern Memory', status: 'ready' }
    ];
  }


  _buildMt5Catalog() {
    return {
      commodities: [
        { symbol: 'XAUUSD', label: 'Gold · XAUUSD', family: 'commodities' },
        { symbol: 'Gold Basket', label: 'Gold Basket', family: 'basket' }
      ],
      volatility: [
        { symbol: 'Volatility 10 Index', label: 'Volatility 10 Index', family: 'synthetic' },
        { symbol: 'Volatility 25 Index', label: 'Volatility 25 Index', family: 'synthetic' },
        { symbol: 'Volatility 50 Index', label: 'Volatility 50 Index', family: 'synthetic' },
        { symbol: 'Volatility 75 Index', label: 'Volatility 75 Index', family: 'synthetic' },
        { symbol: 'Volatility 100 Index', label: 'Volatility 100 Index', family: 'synthetic' },
        { symbol: 'Volatility 150 Index', label: 'Volatility 150 Index', family: 'synthetic' },
        { symbol: 'Volatility 250 Index', label: 'Volatility 250 Index', family: 'synthetic' },
        { symbol: 'Volatility 10 (1s) Index', label: 'Volatility 10 (1s) Index', family: 'synthetic' },
        { symbol: 'Volatility 25 (1s) Index', label: 'Volatility 25 (1s) Index', family: 'synthetic' },
        { symbol: 'Volatility 50 (1s) Index', label: 'Volatility 50 (1s) Index', family: 'synthetic' },
        { symbol: 'Volatility 75 (1s) Index', label: 'Volatility 75 (1s) Index', family: 'synthetic' },
        { symbol: 'Volatility 100 (1s) Index', label: 'Volatility 100 (1s) Index', family: 'synthetic' }
      ],
      crashBoom: [
        { symbol: 'Crash 300 Index', label: 'Crash 300 Index', family: 'synthetic' },
        { symbol: 'Crash 500 Index', label: 'Crash 500 Index', family: 'synthetic' },
        { symbol: 'Crash 600 Index', label: 'Crash 600 Index', family: 'synthetic' },
        { symbol: 'Crash 900 Index', label: 'Crash 900 Index', family: 'synthetic' },
        { symbol: 'Crash 1000 Index', label: 'Crash 1000 Index', family: 'synthetic' },
        { symbol: 'Boom 300 Index', label: 'Boom 300 Index', family: 'synthetic' },
        { symbol: 'Boom 500 Index', label: 'Boom 500 Index', family: 'synthetic' },
        { symbol: 'Boom 600 Index', label: 'Boom 600 Index', family: 'synthetic' },
        { symbol: 'Boom 900 Index', label: 'Boom 900 Index', family: 'synthetic' },
        { symbol: 'Boom 1000 Index', label: 'Boom 1000 Index', family: 'synthetic' }
      ],
      step: [
        { symbol: 'Step Index 0.1', label: 'Step Index 0.1', family: 'synthetic' },
        { symbol: 'Step Index 0.2', label: 'Step Index 0.2', family: 'synthetic' },
        { symbol: 'Step Index 0.3', label: 'Step Index 0.3', family: 'synthetic' },
        { symbol: 'Step Index 0.4', label: 'Step Index 0.4', family: 'synthetic' },
        { symbol: 'Step Index 0.5', label: 'Step Index 0.5', family: 'synthetic' }
      ],
      advanced: [
        { symbol: 'Hybrid Index', label: 'Hybrid Indices', family: 'synthetic' },
        { symbol: 'Spot Volatility Index', label: 'Spot Volatility Indices', family: 'synthetic' },
        { symbol: 'Drift Switching Index', label: 'Drift Switching Indices', family: 'synthetic' },
        { symbol: 'DEX Index', label: 'DEX Indices', family: 'synthetic' },
        { symbol: 'Jump Index', label: 'Jump Indices', family: 'synthetic' },
        { symbol: 'Range Break Index', label: 'Range Break Indices', family: 'synthetic' }
      ],
      baskets: [
        { symbol: 'AUD Basket', label: 'AUD Basket', family: 'basket' },
        { symbol: 'EUR Basket', label: 'EUR Basket', family: 'basket' },
        { symbol: 'GBP Basket', label: 'GBP Basket', family: 'basket' },
        { symbol: 'USD Basket', label: 'USD Basket', family: 'basket' },
        { symbol: 'Gold Basket', label: 'Gold Basket', family: 'basket' }
      ]
    };
  }

  _buildDefaultMissions() {
    return [
      { id: 'mission-1', title: 'Rapid Sequence', text: 'Complete 5 digit trades while Quick Fire stress-tests the parity edge.', level: 1, goal: 5, progress: 0, reward: 'Quest cleared', assignedTo: 'openclaw', status: 'queued', execution: 'QUEUED', kind: 'trade_count' },
      { id: 'mission-2', title: 'Edge Watch', text: 'Keep drawdown controlled while Overseer watches live flow.', level: 2, goal: 1, progress: 0, reward: '+150 XP', assignedTo: 'overseer', status: 'queued', execution: 'WATCHING', kind: 'drawdown_guard' },
      { id: 'mission-3', title: 'Recovery Research', text: 'If losses overtake wins, Jarvis and Strategy Lab must research a stronger setup.', level: 3, goal: 1, progress: 0, reward: '+250 XP', assignedTo: 'jarvis', status: 'queued', execution: 'STANDBY', kind: 'recovery_research' },
      { id: 'mission-4', title: 'MT5 SMC Watch', text: 'Monitor Gold and VIX structure, kill zones, and BOS / CHoCH confirmations before switching venue.', level: 4, goal: 1, progress: 0, reward: '+300 XP', assignedTo: 'overseer', status: 'queued', execution: 'STANDBY', kind: 'mt5_smc_watch' }
    ];
  }

  isFollowingAdmin() {
    return Boolean(this.mt5?.copyTrading?.followAdmin || this.mt5?.copyTrading?.mirrorAdminTrades);
  }

  syncFromMaster(masterState = {}) {
    if (!masterState || !this.isFollowingAdmin()) return;
    const masterMt5 = masterState.mt5 || {};
    this.mt5.activeSymbol = masterMt5.activeSymbol || this.mt5.activeSymbol;
    this.mt5.style = masterMt5.style || this.mt5.style;
    this.mt5.sessionBias = masterMt5.sessionBias || this.mt5.sessionBias;
    this.mt5.productFocus = masterMt5.productFocus || this.mt5.productFocus;
    this.mt5.venueEnabled = Boolean(masterMt5.venueEnabled);
    this.mt5.bridgeConnected = Boolean(masterMt5.bridgeConnected);
    this.mt5.liveTradingEnabled = Boolean(masterMt5.liveTradingEnabled);
    this.mt5.copyTrading.lastAdminSyncAt = Date.now();
    this.mt5.lastRecommendation = `Mirroring admin MT5 setup on ${this.mt5.activeSymbol}. Risk x${this.mt5.copyTrading.riskMultiplier || 1}.`;
    this.overseer.lastAction = `Synced from admin account on ${this.mt5.activeSymbol}`;
  }

  getMt5AccountProfile() {
    return {
      userId: this.userId,
      username: this.username,
      role: this.userRole,
      venueEnabled: this.mt5.venueEnabled,
      liveTradingEnabled: this.mt5.liveTradingEnabled,
      bridgeConnected: this.mt5.bridgeConnected,
      bridgeUrl: this.mt5.bridgeUrl,
      activeSymbol: this.mt5.activeSymbol,
      style: this.mt5.style,
      sessionBias: this.mt5.sessionBias,
      copyTrading: this.mt5.copyTrading,
      accountLogin: this.mt5.accountLogin,
      accountServer: this.mt5.accountServer,
      passwordSet: Boolean(this.mt5.accountPassword),
      productFocus: this.mt5.productFocus || 'MT5 Gold',
      lastRecommendation: this.mt5.lastRecommendation,
      positions: this.mt5.positions || [],
      watchlist: this.mt5.watchlist || [],
      favorites: this.mt5.favorites || [],
      catalog: this.mt5.catalog || this._buildMt5Catalog(),
      smcSettings: this.mt5.smcSettings || DEFAULT_SMC_SETTINGS
    };
  }


  _pushNotice(message, severity = 'info') {
    this.overseer.notices = Array.isArray(this.overseer.notices) ? this.overseer.notices : [];
    this.overseer.notices.unshift({ message, severity, at: Date.now() });
    this.overseer.notices = this.overseer.notices.slice(0, 8);
  }

  _beginResearch(reason = 'Recovery research launched', options = {}) {
    const now = Date.now();
    this.overseer.researchMode = true;
    this.overseer.researchStartedAt = now;
    this.overseer.researchDeadlineAt = now + (options.durationMs || 120000);
    this.overseer.researchPhase = 'detecting';
    this.overseer.lastDecisionAt = now;
    this.overseer.lastAction = reason;
    this.overseer.autonomousSummary = 'Overseer is auditing the latest losses, checking the active edge, and preparing a safer plan.';
    const mission = this._ensureRecoveryMission();
    mission.progress = 1;
    mission.status = 'executing';
    mission.execution = 'DETECTING';
    if (options.pauseTrading && this.running) {
      this.stop();
      this.overseer.tradingLock = true;
    }
    this._setAgentStatus('overseer', 'researching');
    this._setAgentStatus('jarvis', 'researching');
    this._setAgentStatus('strategy', 'researching');
    this._setAgentStatus('regime', 'scanning');
    if (!options.silentNotice) this._pushNotice(reason, options.noticeSeverity || 'warn');
    return mission;
  }

  _advanceResearchCycle() {
    if (!this.overseer.researchMode) return;
    const now = Date.now();
    const startedAt = this.overseer.researchStartedAt || now;
    const elapsed = now - startedAt;
    const mission = this._ensureRecoveryMission();
    let nextPhase = 'detecting';
    if (elapsed >= 90000) nextPhase = 'recommending';
    else if (elapsed >= 45000) nextPhase = 'testing';
    else if (elapsed >= 15000) nextPhase = 'investigating';

    if (nextPhase !== this.overseer.researchPhase) {
      this.overseer.researchPhase = nextPhase;
      const phaseNotice = {
        detecting: 'Overseer opened recovery research and is profiling the last losing trades.',
        investigating: 'Jarvis and Strategy Lab are investigating loss patterns and current market regime.',
        testing: 'Overseer is testing safer entries, reduced stake sizing, and a rotated edge.',
        recommending: 'Overseer is preparing a replacement plan and deployment recommendation.'
      };
      this.overseer.lastAction = phaseNotice[nextPhase];
      this._pushNotice(phaseNotice[nextPhase], nextPhase === 'testing' ? 'info' : 'warn');
    }

    mission.status = 'executing';
    mission.execution = String(nextPhase || 'researching').toUpperCase();
    mission.progress = 1;

    if (now >= (this.overseer.researchDeadlineAt || 0)) {
      this._rotateEdge('overseer timed research deployment');
      this.currentStake = clampStakeForMode(this.mode, Math.max(minStakeForMode(this.mode), this.currentStake * 0.85), minStakeForMode(this.mode));
      this.overseer.researchMode = false;
      this.overseer.researchPhase = 'idle';
      this.overseer.tradingLock = false;
      this.overseer.lastDecisionAt = now;
      this.overseer.lastAction = `Overseer finished research and deployed ${this._getEdgeLabel()}`;
      this.overseer.autonomousSummary = `Research completed in ${Math.round((elapsed || 1) / 1000)}s. Overseer rotated to ${this._getEdgeLabel()} and tightened stake to $${this.currentStake.toFixed(2)}.`;
      mission.status = 'validating';
      mission.execution = 'VALIDATING';
      this._pushNotice(this.overseer.autonomousSummary, 'success');
      if (this.authorized && !this.running) this.start();
    }
  }

  async _runOverseerPulse() {
    await this._syncMt5Events();
    await this._manageMt5TrailingStops();
    if (!this.overseer.autonomyEnabled) return;

    const drawdown = Math.max(0, this.peakPnl - this.sessionPnl);
    const unseenMs = Date.now() - (this.overseer.lastSeenAt || 0);

    const review = reviewLosses(this.tradeHistory);
    const regime = assessRegime({ ticks: this.ticks, digits: this.digits, candles: this.candles, mode: this.mode });
    const adaptivePatch = suggestAdaptivePatch({ mode: this.mode, settings: this.settings, regime, review });
    this.overseerDiagnostics.lossReview = review;
    this.overseerDiagnostics.regime = regime;
    this.overseerDiagnostics.adaptivePatch = adaptivePatch;
    this.overseerDiagnostics.modeScorecard = this._buildModeScorecard();
    this.overseerDiagnostics.qualityScore = Number(((1 - (review.lossRate || 0)) * Math.max(0.2, regime.confidence || 0.4) * 100).toFixed(1));

    if (!this.overseer.researchMode && (review.lossRate >= 0.35 || this.lossStreak >= 2 || drawdown >= Math.max(this.currentStake * 2, 1))) {
      this._applyOverseerOptimization({ regime, review, adaptivePatch, drawdown });
    }

    if (this.running && !this.overseer.researchMode && (this.losses > this.wins || this.lossStreak >= 4 || drawdown >= Math.max(this.currentStake * 4, 2))) {
      this.overseer.tradingLock = true;
      this._beginResearch('Overseer paused trading and opened deeper recovery research', { pauseTrading: true, noticeSeverity: 'warn' });
    } else if (this.overseer.researchMode) {
      this._advanceResearchCycle();
    } else if (!this.running && this.authorized && this.losses <= this.wins && drawdown <= Math.max(this.currentStake * 1.5, 0.75) && this.overseer.tradingLock) {
      this.overseer.tradingLock = false;
      this.overseer.lastAction = 'Overseer cleared the lock and kept StratForge ready';
      this.overseer.lastDecisionAt = Date.now();
      this._pushNotice('Recovery checks passed. StratForge is ready for controlled execution.', 'success');
    } else if (unseenMs >= 6 * 60 * 60 * 1000 && Date.now() - (this.overseer.lastAutonomousUpdateAt || 0) >= 60 * 60 * 1000) {
      this.overseer.lastAutonomousUpdateAt = Date.now();
      this.overseer.lastAction = this.running ? 'Overseer kept StratForge running while you were away' : 'Overseer held the arena in standby while you were away';
      this.overseer.lastDecisionAt = Date.now();
      this.overseer.autonomousSummary = this.running
        ? `While you were away, Overseer kept ${this._getEdgeLabel()} active with ${this.wins} wins, ${this.losses} losses, session P&L ${this.sessionPnl.toFixed(2)}, regime ${regime.regime || 'unknown'}, quality ${this.overseerDiagnostics.qualityScore}.`
        : `While you were away, Overseer kept the arena safe in standby with drawdown ${drawdown.toFixed(2)} and watched for a better edge.`;
      this._pushNotice(this.overseer.autonomousSummary, 'info');
    }

    this._syncMissionProgress();
  }

  _setAgentStatus(agentId, status) {
    const agent = this.agents.find((item) => item.id === agentId || item.name === agentId);
    if (agent) agent.status = status;
  }

  _syncMissionProgress() {
    const drawdown = Math.max(0, this.peakPnl - this.sessionPnl);
    this.missions.forEach((mission) => {
      if (mission.kind === 'trade_count') {
        mission.progress = Math.min(mission.goal, this.trades);
        mission.status = mission.progress >= mission.goal ? 'completed' : (this.running ? 'executing' : 'queued');
        mission.execution = mission.progress >= mission.goal ? 'COMPLETED' : (this.running ? 'EXECUTING' : 'QUEUED');
      }
      if (mission.kind === 'drawdown_guard') {
        mission.progress = drawdown <= Math.max(this.currentStake, MIN_STAKE) ? 1 : 0;
        mission.status = mission.progress >= mission.goal ? 'completed' : 'executing';
        mission.execution = mission.progress >= mission.goal ? 'VALIDATED' : 'WATCHING';
      }
      if (mission.kind === 'mt5_smc_watch') {
        mission.progress = this.mt5.venueEnabled ? 1 : 0;
        mission.status = this.mt5.venueEnabled ? 'executing' : 'queued';
        mission.execution = this.mt5.liveTradingEnabled ? 'LIVE' : (this.mt5.venueEnabled ? 'WATCHING' : 'STANDBY');
      }
      if (mission.kind === 'recovery_research') {
        const shouldResearch = this.losses > this.wins || this.overseer.researchMode;
        mission.progress = shouldResearch ? 1 : 0;
        mission.status = this.overseer.researchMode ? 'executing' : (mission.execution === 'VALIDATING' ? 'validating' : 'queued');
        mission.execution = this.overseer.researchMode
          ? String(this.overseer.researchPhase || 'researching').toUpperCase()
          : (mission.execution === 'VALIDATING' ? 'VALIDATING' : 'STANDBY');
      }
    });

    this._setAgentStatus('overseer', this.overseer.researchMode ? 'researching' : (this.running ? 'watching' : 'ready'));
    this._setAgentStatus('jarvis', this.overseer.researchMode ? 'researching' : (this.running ? 'briefing' : 'ready'));
    this._setAgentStatus('strategy', this.overseer.researchMode ? 'researching' : 'ready');
    this._setAgentStatus('risk', this.overseer.tradingLock ? 'guarding' : 'ready');
    this._setAgentStatus('openclaw', this.running ? 'executing' : 'ready');
    this._setAgentStatus('reviewer', this.trades > 0 ? 'reviewing' : 'ready');
    this._setAgentStatus('memory', this.trades > 0 ? 'indexing' : 'ready');
    this._setAgentStatus('regime', this.running ? 'scanning' : 'ready');
  }

  _ensureRecoveryMission() {
    let mission = this.missions.find((item) => item.kind === 'recovery_research');
    if (!mission) {
      mission = { id: `mission-${Date.now()}`, title: 'Recovery Research', text: 'Jarvis and Strategy Lab are researching a stronger setup after weak performance.', level: 3, goal: 1, progress: 0, reward: '+250 XP', assignedTo: 'jarvis', status: 'queued', execution: 'STANDBY', kind: 'recovery_research' };
      this.missions.unshift(mission);
    }
    return mission;
  }

  _buildModeScorecard() {
    const rows = [];
    const byMode = new Map();
    for (const trade of this.tradeHistory || []) {
      const mode = String(trade.mode || 'unknown');
      if (!byMode.has(mode)) byMode.set(mode, []);
      byMode.get(mode).push(trade);
    }
    for (const [mode, trades] of byMode.entries()) {
      const wins = trades.filter(t => t.result === 'won').length;
      const losses = trades.length - wins;
      const pnl = trades.reduce((sum, t) => sum + Number(t.profit || 0), 0);
      const winRate = trades.length ? wins / trades.length : 0;
      rows.push({ mode, trades: trades.length, wins, losses, pnl: Number(pnl.toFixed(2)), winRate: Number((winRate * 100).toFixed(1)) });
    }
    rows.sort((a,b) => (b.pnl - a.pnl) || (b.winRate - a.winRate));
    return rows;
  }

  _selectSaferMode(regime, review) {
    const lossRate = Number(review?.lossRate || 0);
    if (this.manualModeOverride) return this.mode;
    if (regime?.regime === 'trend' || regime?.recommendation === 'follow_trend') {
      return 'rise_fall';
    }
    if (regime?.regime === 'stable_range') {
      return 'over_under';
    }
    if (lossRate > 0.55) return 'digits';
    return this.mode;
  }

  _applyOverseerOptimization({ regime, review, adaptivePatch, drawdown }) {
    const now = Date.now();
    const current = this.settings || {};
    const next = {};
    let summary = [];

    if ((review?.lossRate || 0) >= 0.45 || this.lossStreak >= 2) {
      const stakeBase = clampStakeForMode(this.mode, current.stakeAmount || this.currentStake || minStakeForMode(this.mode), minStakeForMode(this.mode));
      next.stakeAmount = clampStakeForMode(this.mode, Math.max(minStakeForMode(this.mode), stakeBase * 0.8), minStakeForMode(this.mode));
      next.cooldownMs = Math.max(1500, Number(current.cooldownMs || 0) + 1000);
      next.maxTradesPerSession = Math.max(8, Math.min(Number(current.maxTradesPerSession || 20), 12));
      next.maxLossStreak = Math.max(1, Math.min(Number(current.maxLossStreak || 3), 2));
      summary.push(`reduced stake to $${next.stakeAmount.toFixed(2)}`);
      summary.push(`cooldown ${next.cooldownMs}ms`);
    }

    if ((review?.lossRate || 0) >= 0.55 || drawdown >= Math.max(this.currentStake * 3, 1.5)) {
      const saferMode = this._selectSaferMode(regime, review);
      if (saferMode !== this.mode && !this.manualModeOverride) {
        this.setMode(saferMode, 'disciplined', { manual: false });
        summary.push(`switched mode to ${saferMode}`);
      } else if (this.preset !== 'disciplined') {
        this.setMode(this.mode, 'disciplined', { manual: false });
        summary.push('switched preset to disciplined');
      }
    }

    if (adaptivePatch && typeof adaptivePatch === 'object') {
      Object.assign(next, adaptivePatch);
      summary.push('applied adaptive patch');
    }

    if (regime?.regime === 'chaotic') {
      next.cooldownMs = Math.max(Number(next.cooldownMs || current.cooldownMs || 0), 4000);
      next.maxTradesPerSession = Math.max(6, Math.min(Number(next.maxTradesPerSession || current.maxTradesPerSession || 20), 8));
      summary.push('tightened for chaotic regime');
    }

    if (false && this.mode === 'accumulator' && regime?.regime === 'chaotic') {
      const saferMode = this._selectSaferMode(regime, review);
      if (saferMode !== 'accumulator') {
        this.setMode(saferMode);
        summary.push(`moved away from accumulator into ${saferMode}`);
      }
    }

    if (Object.keys(next).length) {
      this.updateSettings(next, { manual: false, reason: 'overseer-optimization' });
    }

    if (summary.length) {
      const note = summary.join(', ');
      this.overseerDiagnostics.lastOptimization = { at: now, summary: note, mode: this.mode, preset: this.preset };
      this.overseer.lastAction = `Overseer optimized live trading: ${note}`;
      this.overseer.lastDecisionAt = now;
      this.overseer.autonomousSummary = `Overseer is actively adapting ${this.mode}/${this.preset} using regime=${regime?.regime || 'unknown'} and lossRate=${Number(((review?.lossRate || 0)*100).toFixed(1))}%.`;
      this._pushNotice(this.overseer.lastAction, 'warn');
    }
  }

  _maybeTriggerAutonomy() {
    const drawdown = Math.max(0, this.peakPnl - this.sessionPnl);
    const shouldResearch = this.overseer.autonomyEnabled && (this.losses > this.wins || this.lossStreak >= 2 || drawdown >= Math.max(this.currentStake * 2, 1));
    if (!shouldResearch) {
      this._syncMissionProgress();
      return;
    }

    this.overseer.tradingLock = true;
    this._beginResearch('Autonomy triggered recovery research', { pauseTrading: this.running, noticeSeverity: 'warn' });
    this._syncMissionProgress();
  }


  _snapshotStrategyVersion(reason = 'manual') {
    this.overseer.strategyVersions = Array.isArray(this.overseer.strategyVersions) ? this.overseer.strategyVersions : [];
    this.overseer.strategyVersions.unshift({
      at: Date.now(),
      reason,
      preset: this.preset,
      mode: this.mode,
      settings: JSON.parse(JSON.stringify(this.settings || {}))
    });
    this.overseer.strategyVersions = this.overseer.strategyVersions.slice(0, 12);
  }

  _applyGovernorTuning(kind, payload = {}) {
    this._snapshotStrategyVersion(kind);
    if (kind === 'bollinger') {
      const period = Number(payload.period || this.settings.entryFilter?.period || 20);
      const stdDev = Number(payload.stdDev || this.settings.entryFilter?.stdDev || 2);
      this.updateSettings({ entryFilter: { period, stdDev } });
      this.overseer.lastAction = `Governor tuned Bollinger to ${period}/${stdDev}`;
      this._pushNotice(this.overseer.lastAction, 'info');
    }
    if (kind === 'digit_bias') {
      const bias50Threshold = Number(payload.bias50Threshold || payload.bias50 || this.settings.entryFilter?.thresholds?.[50] || 58);
      const bias100Threshold = Number(payload.bias100Threshold || payload.bias100 || this.settings.entryFilter?.thresholds?.[100] || 55);
      this.updateSettings({ bias50Threshold, bias100Threshold });
      this.overseer.lastAction = `Governor tuned digit bias to ${bias50Threshold}% / ${bias100Threshold}%`;
      this._pushNotice(this.overseer.lastAction, 'info');
    }
  }


  _recordMt5Activity(message, level = 'info', extra = {}) {
    this.mt5.activities = Array.isArray(this.mt5.activities) ? this.mt5.activities : [];
    const entry = { id: `mt5-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, at: Date.now(), level, message, ...extra };
    this.mt5.activities.unshift(entry);
    this.mt5.activities = this.mt5.activities.slice(0, 60);
    this.emit('mt5_event', { type: 'activity', status: level, payload: entry });
  }

  async _queueMt5Command(type, payload = {}, dedupeKey = null) {
    try {
      const queued = await this.mt5Execution.enqueue(type, payload, dedupeKey);
      if (queued?.command?.id) {
        this._recordMt5Activity(`Queued MT5 ${type}${payload.symbol ? ` on ${payload.symbol}` : ''}`, 'info', { commandId: queued.command.id, commandType: type, payload });
      }
      return queued;
    } catch (error) {
      this.log(`MT5 queue error (${type}): ${error.message}`);
      this.mt5.bridgeConnected = false;
      this.mt5.liveExecutionNote = error.message;
      this._recordMt5Activity(`MT5 queue error for ${type}: ${error.message}`, 'error', { commandType: type, payload });
      return null;
    }
  }

  async _syncMt5Events() {
    try {
      const fresh = await this.mt5Execution.syncEvents();
      this.mt5.lastSyncError = '';
      if (fresh.length) {
        this.mt5.bridgeConnected = true;
        this.mt5.lastEventAt = Date.now();
      }
      return fresh;
    } catch (error) {
      const syncMessage = error?.message || 'fetch failed';
      this.mt5.bridgeConnected = false;
      if (this.mt5.lastSyncError !== syncMessage) {
        this._pushNotice(`MT5 event sync failed: ${syncMessage}`, 'warn');
        this.log(`MT5 event sync failed: ${syncMessage}`);
        this.mt5.lastSyncError = syncMessage;
      }
      return [];
    }
  }

  _handleMt5Event(event = {}) {
    this.mt5.latestEvent = event;
    const type = String(event.type || '');
    const payload = event.payload || {};
    const status = String(event.status || 'info');
    if (type === 'account_info') {
      this.mt5.accountLogin = String(payload.login || this.mt5.accountLogin || '');
      this.mt5.accountServer = String(payload.server || this.mt5.accountServer || '');
      this.mt5.terminalConnected = true;
      this.mt5.bridgeConnected = true;
      this.mt5.liveExecutionNote = 'MT5 bridge confirmed account connectivity.';
      this._recordMt5Activity(`MT5 connected${payload.login ? ` · ${payload.login}` : ''}${payload.server ? ` · ${payload.server}` : ''}${payload.balance !== undefined ? ` · Balance $${Number(payload.balance).toFixed(2)}` : ''}`, 'success', { type, payload });
    }
    if (type === 'positions') {
      if (Array.isArray(payload.positions)) this.mt5.positions = payload.positions;
      else if (Array.isArray(payload)) this.mt5.positions = payload;
      else if (typeof payload.count === 'number' && !Array.isArray(this.mt5.positions)) this.mt5.positions = [];
      this._recordMt5Activity(`MT5 positions sync${payload.count !== undefined ? ` · ${payload.count} open` : ''}`, 'info', { type, payload });
    }
    if (type === 'place_order') {
      this.mt5.pendingSignal = null;
      this.mt5.lastTradeEvent = event;
      if (status === 'done') {
        this.mt5.liveExecutionNote = `MT5 trade placed${payload.side ? ` · ${String(payload.side).toUpperCase()}` : ''}${payload.symbol ? ` ${payload.symbol}` : ''}${payload.entryPrice ? ` @ ${Number(payload.entryPrice).toFixed(2)}` : ''}`;
        this.overseer.lastAction = `Overseer placed ${payload.side || 'trade'} ${payload.symbol || ''} on MT5`;
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice('SMC order routed to MT5.', 'success');
        this._recordMt5Activity(this.mt5.liveExecutionNote, 'success', { type, payload });
      } else {
        this.mt5.liveExecutionNote = payload.error || payload.comment || 'MT5 order failed.';
        this._pushNotice(this.mt5.liveExecutionNote, 'warn');
        this._recordMt5Activity(`MT5 order failed: ${this.mt5.liveExecutionNote}`, 'error', { type, payload });
      }
    }
    if (type === 'modify_sl_tp') {
      if (status === 'done') {
        this.mt5.liveExecutionNote = 'Trailing stop updated on MT5.';
        this.mt5.overseerTrailStatus = `Trailing updated${payload.ticket ? ` · ticket ${payload.ticket}` : ''}${payload.sl ? ` · SL ${Number(payload.sl).toFixed(2)}` : ''}`;
        this._recordMt5Activity(this.mt5.overseerTrailStatus, 'success', { type, payload });
      } else {
        this._recordMt5Activity(`Trailing update failed: ${payload.error || 'unknown error'}`, 'error', { type, payload });
      }
    }
    if (type === 'close_position') {
      this._recordMt5Activity(status === 'done' ? `Position closed${payload.ticket ? ` · ticket ${payload.ticket}` : ''}` : `Close failed: ${payload.error || 'unknown error'}`, status === 'done' ? 'success' : 'error', { type, payload });
    }
    if (type === 'flatten') {
      if (status === 'done') {
        this.mt5.positions = [];
        this.mt5.liveExecutionNote = 'All MT5 positions flattened.';
        this._recordMt5Activity(`Flatten complete${payload.closed !== undefined ? ` · ${payload.closed} closed` : ''}`, 'success', { type, payload });
      } else {
        this._recordMt5Activity(`Flatten failed: ${payload.error || 'unknown error'}`, 'error', { type, payload });
      }
    }
    this.emit('mt5_event', event);
    this.emit('state', this.getState());
  }

  _getMt5Symbol() {
    return this.mt5.activeSymbol || (this.mt5.watchlist && this.mt5.watchlist[0]) || 'XAUUSD';
  }

  _isMt5ExecutionReady() {
    return Boolean(
      this.running &&
      this.authorized &&
      this.mt5 && this.mt5.venueEnabled &&
      this.mt5.liveTradingEnabled &&
      !(this.overseer && this.overseer.tradingLock)
    );
  }

  async _evaluateSmcVenue() {
    if (!this._isMt5ExecutionReady()) return null;
    if (!Array.isArray(this.candles) || this.candles.length < 30) return null;
    const last = this.candles[this.candles.length - 1];
    if (!last) return null;
    const signalPack = buildSmcSignal(this.candles, {
      symbol: this._getMt5Symbol(),
      settings: this.mt5.smcSettings
    });
    const signal = signalPack.signal;
    this.mt5.sessionBias = (((signalPack || {}).diagnostics || {}).structure || {}).bias || this.mt5.sessionBias;
    this.mt5.lastRecommendation = signal
      ? `${signal.side.toUpperCase()} ${signal.symbol} | ${signal.rationale} | SL ${signal.sl.toFixed(2)} | TP ${signal.tp.toFixed(2)}`
      : `SMC standby: ${((signalPack || {}).diagnostics || {}).reason || 'Awaiting structure confirmation'}`;
    if (!signal) return null;

    const signalKey = `${signal.symbol}:${signal.side}:${last.time}`;
    if (this.mt5.lastSignalKey === signalKey) return null;
    const matchingPositions = Array.isArray(this.mt5.positions)
      ? this.mt5.positions.filter((pos) => String(pos.symbol || pos.activeSymbol || '') === signal.symbol)
      : [];
    if (matchingPositions.length) return null;

    const volume = Number((Math.max(0.01, 0.01 * Number((((this.mt5 || {}).copyTrading || {}).riskMultiplier || 1))).toFixed(2)));
    const payload = {
      symbol: signal.symbol,
      side: signal.side,
      volume,
      sl: Number(signal.sl.toFixed(2)),
      tp: Number(signal.tp.toFixed(2)),
      rationale: signal.rationale,
      atr: Number(signal.atr.toFixed(5)),
      risk: Number(signal.risk.toFixed(5))
    };

    const queued = await this._queueMt5Command('place_order', payload, signalKey);
    if (queued) {
      this.mt5.pendingSignal = { ...signal, queuedAt: Date.now(), payload };
      this.mt5.lastSignalAt = Date.now();
      this.mt5.lastSignalKey = signalKey;
      this.overseer.lastAction = `Overseer queued ${signal.side} ${signal.symbol} via SMC`;
      this.overseer.lastDecisionAt = Date.now();
      this.mt5.liveExecutionNote = `${signal.side.toUpperCase()} ${signal.symbol} queued by Overseer · ${signal.rationale}`;
      this._pushNotice(this.overseer.lastAction, 'success');
      this._recordMt5Activity(`${this.mt5.liveExecutionNote} · SL ${payload.sl} · TP ${payload.tp}`, 'info', { type: 'signal', payload });
      this.emit('state', this.getState());
    }
    return queued;
  }

  async _manageMt5TrailingStops() {
    if (!this._isMt5ExecutionReady()) return null;
    if (!Array.isArray(this.mt5.positions) || !this.mt5.positions.length) return null;
    const now = Date.now();
    if (now - (this.mt5.trailing.lastTrailAt || 0) < 5000) return null;
    let updated = 0;
    for (const position of this.mt5.positions) {
      const plan = buildTrailingPlan(position, this.candles, { settings: this.mt5.smcSettings });
      if (!plan) continue;
      const dedupeKey = `trail:${plan.position_ticket}:${plan.sl}`;
      const res = await this._queueMt5Command('modify_sl_tp', plan, dedupeKey);
      if (res) {
        updated += 1;
        this.overseer.lastAction = `Overseer trailed ${position.symbol || position.activeSymbol || ''}${plan.sl ? ` to SL ${Number(plan.sl).toFixed(2)}` : ''}`;
      }
    }
    this.mt5.trailing.lastTrailAt = now;
    return updated;
  }

  _applyMt5Venue(payload = {}) {
    this.mt5.venueEnabled = payload.enabled !== false;
    this.mt5.activeSymbol = payload.symbol || this.mt5.activeSymbol;
    this.mt5.style = payload.style || this.mt5.style;
    if (this.mt5.activeSymbol && !this.mt5.watchlist.includes(this.mt5.activeSymbol)) this.mt5.watchlist.unshift(this.mt5.activeSymbol);
    this.mt5.watchlist = this.mt5.watchlist.slice(0, 12);
    this.mt5.sessionBias = payload.sessionBias || this.mt5.sessionBias;
    if (payload.bridgeUrl) this.mt5.bridgeUrl = payload.bridgeUrl;
    if (payload.accountLogin !== undefined) this.mt5.accountLogin = String(payload.accountLogin || '');
    if (payload.accountServer !== undefined) this.mt5.accountServer = String(payload.accountServer || '');
    if (payload.accountPassword !== undefined) this.mt5.accountPassword = String(payload.accountPassword || '');
    this.overseer.lastAction = `MT5 venue ${this.mt5.venueEnabled ? 'armed' : 'standby'} on ${this.mt5.activeSymbol}`;
    this.mt5.lastRecommendation = `${this.mt5.activeSymbol} is under ${this.mt5.style} supervision. Wait for structure confirmation before live routing.`;
    this._pushNotice(this.overseer.lastAction, this.mt5.venueEnabled ? 'success' : 'info');
  }

  _setCopyTrading(payload = {}) {
    this.mt5.copyTrading.followAdmin = payload.followAdmin !== false;
    this.mt5.copyTrading.mirrorAdminTrades = payload.mirrorAdminTrades !== false;
    this.mt5.copyTrading.riskMultiplier = Math.max(0.1, Number(payload.riskMultiplier || this.mt5.copyTrading.riskMultiplier || 1));
    this.mt5.copyTrading.sameAsAdmin = payload.sameAsAdmin === true;
    this.overseer.lastAction = this.mt5.copyTrading.followAdmin ? 'User account is now following admin MT5 flow' : 'User account is no longer following admin MT5 flow';
    this._pushNotice(this.overseer.lastAction, 'info');
  }

  _setMt5LiveTrading(payload = {}) {
    this.mt5.liveTradingEnabled = payload.enabled === true;
    this.mt5.bridgeConnected = payload.bridgeConnected === true || (payload.enabled === true && Boolean(this.mt5.bridgeUrl));
    this.mt5.liveExecutionNote = this.mt5.liveTradingEnabled
      ? `Live MT5 trading armed for ${this.mt5.activeSymbol}. Overseer can queue live MT5 orders when structure confirms.`
      : 'Live MT5 trading is off. Supervision and recommendation mode only.';
    this.overseer.lastAction = this.mt5.liveTradingEnabled ? 'MT5 live trading armed' : 'MT5 live trading disarmed';
    this._pushNotice(this.mt5.liveExecutionNote, this.mt5.liveTradingEnabled ? 'warn' : 'info');
  }

  _saveAssistantNote(text) {
    if (!String(text || '').trim()) return;
    this.assistant.notes.unshift({ id: `note-${Date.now()}`, text: String(text).trim(), at: Date.now() });
    this.assistant.notes = this.assistant.notes.slice(0, 12);
    this.overseer.lastAction = 'Assistant note saved';
    this._pushNotice(`Overseer saved note: ${String(text).trim()}`, 'info');
  }

  getMissionState() {
    this.overseer.lastSeenAt = Date.now();
    this._syncMissionProgress();
    const levels = [1, 2, 3, 4].map((level) => ({
      level,
      missions: this.missions.filter((mission) => Number(mission.level || 1) === level)
    }));
    const primaryMission = this.missions.find((mission) => mission.status !== 'completed') || this.missions[0] || null;
    return {
      primaryMission,
      missions: this.missions,
      levels,
      agents: this.agents,
      overseer: this.overseer,
      mt5: this.mt5,
      assistant: this.assistant
    };
  }

  executeOverseerCommand(command, payload = {}) {
    const nextStake = () => clampStake(payload.stakeAmount ?? this.currentStake);

    switch (command) {
      case 'pause_bot':
        this.overseer.tradingLock = true;
        this.overseer.lastAction = 'Paused bot';
        this.overseer.lastDecisionAt = Date.now();
        this.stop();
        this._pushNotice('Overseer paused live trading.', 'warn');
        break;
      case 'resume_bot':
        this.overseer.tradingLock = false;
        this.overseer.researchMode = false;
        this.overseer.lastAction = 'Resumed bot';
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice('Overseer resumed live trading.', 'success');
        if (this.authorized) this.start();
        break;
      case 'force_research':
        this._beginResearch('Forced research mission', { pauseTrading: this.running, noticeSeverity: 'info' });
        break;
      case 'deploy_new_strategy':
        this.overseer.researchMode = false;
        this.overseer.researchPhase = 'idle';
        this.overseer.tradingLock = false;
        this._rotateEdge('overseer deployment');
        this.currentStake = clampStakeForMode(this.mode, this.settings.stakeAmount ?? nextStake(), minStakeForMode(this.mode));
        this.overseer.lastAction = 'Deployed refreshed strategy';
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice(`Overseer deployed ${this._getEdgeLabel()}.`, 'success');
        break;
      case 'tighten_risk':
        this.currentStake = clampStakeForMode(this.mode, Math.max(minStakeForMode(this.mode), nextStake() * 0.75), minStakeForMode(this.mode));
        this.overseer.lastAction = 'Tightened risk controls';
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice(`Stake tightened to $${this.currentStake.toFixed(2)}.`, 'warn');
        break;
      case 'boost_bot':
        this.currentStake = clampStakeForMode(this.mode, nextStake() * 1.1, minStakeForMode(this.mode));
        this.overseer.lastAction = 'Boosted bot execution room';
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice(`Stake boosted to $${this.currentStake.toFixed(2)}.`, 'info');
        break;
      case 'set_autonomy':
        this.overseer.autonomyEnabled = payload.enabled !== false;
        this.overseer.lastAction = this.overseer.autonomyEnabled ? 'Autonomy enabled' : 'Autonomy disabled';
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice(`Autonomy ${this.overseer.autonomyEnabled ? 'enabled' : 'disabled'}.`, 'info');
        break;
      case 'set_overseer_mode':
        this.assistant.mode = payload.mode || 'assistant';
        this.overseer.mode = this.assistant.mode;
        this.overseer.lastAction = `Overseer switched to ${this.assistant.mode} mode`;
        this._pushNotice(this.overseer.lastAction, 'info');
        break;
      case 'set_trade_venue':
        this._applyMt5Venue(payload);
        break;
      case 'set_product_focus':
        this.mt5.productFocus = payload.focus || 'Gold';
        this.overseer.lastAction = `Product focus moved to ${this.mt5.productFocus}`;
        this._pushNotice(this.overseer.lastAction, 'info');
        break;
      case 'set_copy_trading':
        this._setCopyTrading(payload);
        break;
      case 'set_mt5_live':
        this._setMt5LiveTrading(payload);
        break;
      case 'update_smc_settings':
        this.mt5.smcSettings = mergeSmcSettings(this.mt5.smcSettings, payload || {});
        this.overseer.lastAction = 'SMC execution settings updated';
        this._pushNotice(this.overseer.lastAction, 'info');
        break;
      case 'tune_bollinger':
        this._applyGovernorTuning('bollinger', payload);
        break;
      case 'tune_digit_bias':
        this._applyGovernorTuning('digit_bias', payload);
        break;
      case 'major_recommend':
        this.overseer.majorRecommendation = {
          summary: `Shift to ${this.mt5.venueEnabled ? 'MT5' : 'Deriv'} ${this.mt5.activeSymbol || this.market} with tighter confirmations, ${this._getEdgeLabel()} as fallback, and ${this.mt5.copyTrading.followAdmin ? 'admin mirroring ready' : 'per-account autonomy'} enabled.`,
          confidence: Math.max(52, Math.min(91, 60 + (this.wins - this.losses) * 4)),
          impact: this.losses > this.wins ? 'Defensive upside with capital protection' : 'Controlled upside expansion',
          rollbackTarget: this.overseer.strategyVersions?.[0]?.reason || 'last stable snapshot'
        };
        this.overseer.lastAction = 'Major recommendation prepared';
        this._pushNotice('Overseer prepared a major recommendation upgrade.', 'success');
        break;
      case 'save_assistant_note':
        this._saveAssistantNote(payload.text || '');
        break;
      case 'create_mission':
        this.missions.unshift({
          id: `mission-${Date.now()}`,
          title: payload.title || 'Overseer Mission',
          text: payload.text || 'New mission issued by Overseer.',
          level: Number(payload.level || 1),
          goal: Math.max(1, Number(payload.goal || 1)),
          progress: 0,
          reward: payload.reward || '+100 XP',
          assignedTo: payload.assignedTo || 'overseer',
          status: 'queued',
          execution: 'QUEUED',
          kind: payload.kind || 'manual'
        });
        this.overseer.lastAction = `Created mission: ${payload.title || 'Overseer Mission'}`;
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice('A new Overseer mission is live on the board.', 'success');
        break;
      default:
        this.overseer.lastAction = `Command noted: ${command}`;
        this.overseer.lastDecisionAt = Date.now();
        this._pushNotice(`Overseer received ${command}.`, 'info');
        break;
    }

    this._syncMissionProgress();
    return this.getMissionState();
  }

  // ----- Controls ----------------------------------------------
  _setStatus(status) {
    this.status = status;
    this.running = status === 'running';
    this.emit('bot_state', { running: this.running, status: this.status });
  }

  start(options = {}) {
    const { resume = false } = options;
    if (!this.authorized) {
      this.log('Not authorized');
      return;
    }

    if (!this.sessionStartBalance) this.sessionStartBalance = this.balance;
    if (this.trades === 0 && this.sessionPnl === 0) {
      this.sessionStartBalance = this.balance || this.sessionStartBalance;
      this.sessionStartedAt = Date.now();
    }

    this._setStatus('running');
    if (!resume) {
      this.log(`Bot started | Mode: ${this.mode} | Preset: ${this.preset} | Edge: ${this._getEdgeLabel()}`);
    }
  }

  stop() {
    this._resumeAfterReconnect = false;
    this._clearPendingTrade();
    this._setStatus('stopped');
    this.log('Bot stopped');
  }

  resetSession() {
    this.sessionStartedAt = Date.now();
    this.sessionStartBalance = this.balance || this.sessionStartBalance;
    this.sessionPnl = 0;
    this.peakPnl = 0;
    this.trades = 0;
    this.wins = 0;
    this.losses = 0;
    this.lossStreak = 0;
    this.currentStake = clampStakeForMode(this.mode, this.settings.stakeAmount || minStakeForMode(this.mode), minStakeForMode(this.mode));
    this.missions = this._buildDefaultMissions();
    this.tradeHistory = [];
    this._edgeSession = this._freshEdgeSession();
    this._clearPendingTrade();
    this.emit('stats', this._getStats());
    this.log('Session reset');
  }

  resetAnalyzer() {
    this.digits = [];
    this.ticks = [];
    this.emit('analyzer_reset');
    this.log('Analyzer reset');
  }

  // ----- Helpers -----------------------------------------------
  _getStats() {
    const settledTrades = this.trades || (this.wins + this.losses);
    const winRate = settledTrades > 0 ? ((this.wins / settledTrades) * 100).toFixed(1) : '0.0';
    const balanceReturnPct = this.sessionStartBalance > 0
      ? ((this.sessionPnl / this.sessionStartBalance) * 100).toFixed(1)
      : '0.0';

    return {
      balance: this.balance,
      market: this.market,
      mode: this.mode,
      preset: this.preset,
      sessionStartBalance: this.sessionStartBalance,
      sessionStartedAt: this.sessionStartedAt,
      sessionPnl: this.sessionPnl,
      peakPnl: this.peakPnl,
      trades: settledTrades,
      wins: this.wins,
      losses: this.losses,
      lossStreak: this.lossStreak,
      winRate,
      balanceReturnPct,
      currentStake: clampStakeForMode(this.mode, this.currentStake, minStakeForMode(this.mode)),
      worstDrawdown: Math.max(0, this.peakPnl - this.sessionPnl),
      xp: this.xp,
      level: this.level,
      levelName: LEVEL_NAMES[this.level] || 'Legend',
      running: this.running,
      status: this.status,
      autoEdgeEnabled: this.autoEdgeEnabled,
      edgeLabel: this._getEdgeLabel(),
      edgeSession: this._edgeSnapshot()
    };
  }

  getState() {
    return {
      connected: this.connected,
      authorized: this.authorized,
      market: this.market,
      mode: this.mode,
      preset: this.preset,
      selectedPreset: this.selectedPreset,
      settings: this.settings,
      tradeHistory: this.tradeHistory,
      missionState: this.getMissionState(),
      overseer: this.overseer,
      overseerDiagnostics: this.overseerDiagnostics,
      agents: this.agents,
      mt5: this.mt5,
      accumulator: this.accumulator,
      assistant: this.assistant,
      ...this._getStats()
    };
  }

  emit(event, data) {
    this.broadcast(this.userId, event, data);
  }

  log(msg) {
    this.emit('log', { msg, time: Date.now() });
  }
}

const LEVEL_NAMES = {
  1: 'Rookie',
  2: 'Analyst',
  3: 'Sniper',
  4: 'Strategist',
  5: 'Mastermind',
  6: 'Phantom',
  7: 'Legend'
};

module.exports = { DerivBot, MARKETS, LEVEL_NAMES };
