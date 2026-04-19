/* ──────────────────────────────────────────────────────────────────
   STRATFORGE ARENA — Frontend App
────────────────────────────────────────────────────────────────── */

const App = (() => {
  // ─── State ────────────────────────────────────────────────────
  let ws       = null;
  let token    = null;
  let username = null;
  let role     = null;
  let mode     = 'rise_fall';
  let accumulatorState = { enabled:false, stepPct:0.35, targetPct:2.0, notes:'Accumulator dashboard ready' };
  let preset   = 'balanced';
  let PRESETS  = {};
  let lastStats = null;
  let autoEdgeEnabled = true;
  let pendingSocketAuthToken = null;
  let pendingDerivToken = null;
  let socketAuthed = false;
  let derivConnected = false;
  let hasShownApp = false;
  let lastOverseerActionSeen = '';
  let lastOverseerDiagSeen = '';

  let ticks      = [];
  let digits     = [];
  let candles    = [];
  let tickCount  = 0;
  let sessionStart = null;
  let bestStreak = 0;
  let worstDrawdown = 0;
  let botStatus = 'ready';
  let settingsDirty = false;
  let pendingSettingsSave = false;
  let statusTimer = null;
  let durationTimerId = null;

  const XP_THRESHOLDS = [0, 500, 1500, 3000, 6000, 12000, 25000];
  const MODE_LABELS = { rise_fall: 'Rise / Fall', over_under: 'Over / Under', digits: 'Digits Lab', accumulator: 'Accumulator' };

  function optionalNumber(id, parser = parseFloat) {
    const el = document.getElementById(id);
    if (!el) return null;
    const raw = String(el.value ?? '').trim();
    if (raw === '') return null;
    const n = parser(raw);
    return Number.isFinite(n) ? n : null;
  }

  function compactPayload(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
  }

  function syncStakeInputForMode() {
    const el = document.getElementById('cfgStake');
    if (!el) return;
    const min = mode === 'accumulator' ? 1 : 0.35;
    el.min = String(min);
    const current = parseFloat(el.value);
    if (Number.isFinite(current) && current < min) el.value = min.toFixed(2);
  }
  const PRESET_LABELS = { balanced: 'Balanced Play', aggressive: 'Quick Fire', disciplined: 'Calm Mode' };
  const EDGE_REVIEW_WINDOW = 5;
  const MOBILE_BREAKPOINT = 860;

  // ─── WebSocket ────────────────────────────────────────────────
  function initWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      const saved = pendingSocketAuthToken || localStorage.getItem('arena_token');
      if (saved) {
        token = saved;
        authenticateSocket(saved);
      }
    };

    ws.onmessage = (e) => {
      try { handleMsg(JSON.parse(e.data)); } catch {}
    };

    ws.onclose = () => {
      socketAuthed = false;
      derivConnected = false;
      setTimeout(initWS, 3000);
      updateConnPill(false);
    };

    ws.onerror = () => {};
  }

  function send(action, payload = {}) {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ action, payload }));
  }

  function authenticateSocket(nextToken = token) {
    if (!nextToken) return false;
    pendingSocketAuthToken = nextToken;

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      initWS();
      return false;
    }

    if (ws.readyState !== WebSocket.OPEN) return false;

    ws.send(JSON.stringify({ action: 'auth', payload: { token: nextToken } }));
    pendingSocketAuthToken = null;
    return true;
  }

  function clearSavedSession() {
    localStorage.removeItem('arena_token');
    token = null;
    pendingSocketAuthToken = null;
    socketAuthed = false;
  }

  function restoreDerivTokenInput() {
    const savedToken = localStorage.getItem('deriv_api_token') || '';
    const input = document.getElementById('apiToken');
    if (input && !input.value) input.value = savedToken;
    return savedToken;
  }

  function requestDerivConnect(nextToken, silent = false) {
    const t = String(nextToken || '').trim();
    if (!t) {
      if (!silent) addLog('Enter your Deriv API token first', 'warn');
      return false;
    }
    localStorage.setItem('deriv_api_token', t);
    pendingDerivToken = t;

    if (!token) {
      if (!silent) addLog('Your session expired. Please sign in again.', 'warn');
      return false;
    }

    if (!ws || ws.readyState === WebSocket.CLOSED) {
      initWS();
      if (!silent) addLog('App connection is still starting. Your Deriv token was saved and will connect automatically.', 'warn');
      return false;
    }

    if (ws.readyState !== WebSocket.OPEN || !socketAuthed) {
      authenticateSocket(token);
      if (!silent) addLog('App connection is still starting. Your Deriv token was saved and will connect automatically.', 'warn');
      return false;
    }

    addLog('Connecting to Deriv...', 'info');
    send('connect_deriv', { token: t });
    pendingDerivToken = null;
    return true;
  }

  // ─── Message handler ──────────────────────────────────────────
  function handleMsg(msg) {
    const { event, data } = msg;

    switch (event) {
      case 'auth_ok':
        socketAuthed = true;
        clearLoginError();
        clearSignupError();
        showApp(data.username, data.role, data.state);
        {
          const savedDerivToken = pendingDerivToken || localStorage.getItem('deriv_api_token');
          if (savedDerivToken && !(data.state && data.state.connected)) {
            setTimeout(() => requestDerivConnect(savedDerivToken, true), 150);
          }
        }
        break;
      case 'auth_failed':
        socketAuthed = false;
        clearSavedSession();
        showLoginError('Session expired. Please log in again.');
        showLoginScreen();
        break;

      case 'connection':
        derivConnected = Boolean(data.connected);
        updateConnPill(data.connected);
        setStatCard('scConnected', data.connected ? 'Yes' : 'No', data.connected ? 'green' : '');
        if (data.connected) {
          pendingDerivToken = null;
          addLog('Connected to Deriv', 'success');
        } else {
          addLog('Disconnected from Deriv', 'warn');
        }
        break;

      case 'authorized':
        addLog(`Authorized · Balance: $${parseFloat(data.balance).toFixed(2)}`, 'success');
        updateBalance(data.balance);
        break;

      case 'balance':
        updateBalance(data.balance);
        break;

      case 'tick':
        tickCount++;
        ticks.push(data.price);
        if (ticks.length > 200) ticks.shift();
        digits.push(data.lastDigit);
        if (digits.length > 200) digits.shift();
        updateTickDisplay(data.price, data.lastDigit, data.analyzerData);
        break;

      case 'candle':
        addCandle(data);
        break;

      case 'bot_state':
        applyBotState(data);
        break;

      case 'trade_opened':
        addLog(`Trade opened: ${data.direction} · Stake: $${parseFloat(data.stake).toFixed(2)}`, 'info');
        updateStatusBanner('live');
        break;

      case 'trade_result':
        handleTradeResult(data);
        break;

      case 'stats':
        updateStats(data);
        break;

      case 'xp':
        updateXP(data.xp, data.level);
        break;

      case 'level_up':
        showLevelUp(data.level, data.name);
        break;

      case 'settings_applied':
        syncModePresetUI(data.mode, data.preset);
        updatePresetInfoCard(data.mode, data.preset, { ...(data.settings || {}), edgeLabel: data.edgeLabel });
        settingsDirty = false;
        pendingSettingsSave = false;
        hydrateSettingsInputs(data.settings, { force: true });
        lastStats = { ...(lastStats || {}), mode: data.mode || mode, preset: data.preset || preset, edgeLabel: data.edgeLabel, autoEdgeEnabled: data.autoEdge };
        syncAutoEdgeButton(data.autoEdge, data.edgeLabel);
        updateGameAdditions(lastStats);
        addLog(`Preset applied: ${data.edgeLabel || data.preset} (${data.mode})`, 'info');
        break;

      case 'settings_saved':
        addLog('Settings saved', 'success');
        if (data?.settings) {
          updatePresetInfoCard(mode, preset, data.settings);
          settingsDirty = false;
        pendingSettingsSave = false;
        hydrateSettingsInputs(data.settings, { force: true });
        }
        break;

      case 'pause':
        addLog(`⚠ Bot paused: ${data.reason}`, 'warn');
        applyBotState({ status: 'ready', running: false });
        break;

      case 'error':
        addLog(`Error: ${data.message || data}`, 'error');
        break;

      case 'log':
        addLog(data.msg, 'info');
        break;

      case 'mt5_event':
        handleMt5Event(data);
        break;

      case 'analyzer_reset':
        digits = [];
        ticks  = [];
        addLog('Analyzer reset', 'info');
        break;

      case 'state':
        applyState(data);
        break;
    }
  }


  function handleMt5Event(data = {}) {
    const type = String(data?.type || 'mt5');
    const status = String(data?.status || 'info');
    const payload = data?.payload || {};
    let msg = `MT5 ${type} ${status}`;

    if (type === 'place_order') {
      if (status === 'done') {
        const side = payload.side ? String(payload.side).toUpperCase() : 'ORDER';
        const symbol = payload.symbol || '';
        const order = payload.order || payload.deal || '';
        const entry = payload.entryPrice ?? payload.price ?? payload.executedPrice;
        const sl = payload.sl;
        const tp = payload.tp;
        msg = `MT5 order placed: ${side} ${symbol} ${entry ? `@ ${Number(entry).toFixed(2)}` : ''}${order ? ` · ticket ${order}` : ''}${sl ? ` · SL ${Number(sl).toFixed(2)}` : ''}${tp ? ` · TP ${Number(tp).toFixed(2)}` : ''}`;
      } else {
        msg = `MT5 order failed: ${payload.error || payload.comment || 'unknown error'}`;
      }
    } else if (type === 'modify_sl_tp') {
      if (status === 'done') msg = `MT5 trailing stop updated${payload.ticket ? ` · ticket ${payload.ticket}` : ''}${payload.sl ? ` · SL ${Number(payload.sl).toFixed(2)}` : ''}${payload.tp ? ` · TP ${Number(payload.tp).toFixed(2)}` : ''}`;
      else msg = `MT5 SL/TP update failed: ${payload.error || 'unknown error'}`;
    } else if (type === 'close_position') {
      msg = status === 'done'
        ? `MT5 position closed${payload.ticket ? ` · ticket ${payload.ticket}` : ''}`
        : `MT5 position close failed: ${payload.error || 'unknown error'}`;
    } else if (type === 'flatten') {
      msg = status === 'done'
        ? `MT5 flatten complete${payload.closed !== undefined ? ` · ${payload.closed} closed` : ''}`
        : `MT5 flatten failed: ${payload.error || 'unknown error'}`;
    } else if (type === 'account_info') {
      msg = `MT5 connected${payload.login ? ` · ${payload.login}` : ''}${payload.server ? ` · ${payload.server}` : ''}${payload.balance !== undefined ? ` · Balance $${Number(payload.balance).toFixed(2)}` : ''}`;
    } else if (type === 'positions') {
      msg = `MT5 positions sync${payload.count !== undefined ? ` · ${payload.count} open` : ''}`;
    }

    addLog(msg, status === 'failed' ? 'error' : status === 'done' ? 'success' : 'info');
  }

  // ─── Auth ─────────────────────────────────────────────────────
  async function login() {
    const user = document.getElementById('loginUser').value.trim();
    const pass = document.getElementById('loginPass').value;
    if (!user || !pass) return;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (!res.ok) return showLoginError(data.error || 'Login failed');
      token    = data.token;
      username = data.username;
      role     = data.role;
      localStorage.setItem('arena_token', token);
      clearLoginError();
      showApp(username, role, null);
      if (!authenticateSocket(token)) {
        showLoginError('Signed in. Finishing secure session...');
      }
    } catch { showLoginError('Network error'); }
  }

  async function signup() {
    const user = document.getElementById('signupUser').value.trim();
    const pass = document.getElementById('signupPass').value;
    if (!user || !pass) return;
    try {
      const res = await fetch('/api/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (!res.ok) return showSignupError(data.error || 'Signup failed');
      token    = data.token;
      username = data.username;
      role     = data.role;
      localStorage.setItem('arena_token', token);
      clearSignupError();
      showApp(username, role, null);
      if (!authenticateSocket(token)) {
        showSignupError('Account created. Finishing secure session...');
      }
    } catch { showSignupError('Network error'); }
  }

  function logout() {
    clearSavedSession();
    hasShownApp = false;
    showLoginScreen();
  }

  // ─── Screen management ────────────────────────────────────────
  function showApp(uname, urole, state) {
    username = uname;
    role     = urole;
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('appScreen').classList.remove('hidden');
    document.getElementById('avatarInitials').textContent = uname.substring(0,2).toUpperCase();
    document.getElementById('userMenuName').textContent = uname;
    document.getElementById('userMenuRole').textContent = urole;
    if (urole === 'admin') {
      document.getElementById('adminLink').classList.remove('hidden');
      document.getElementById('adminTab').classList.remove('hidden');
    }

    restoreDerivTokenInput();

    if (!hasShownApp) {
      fetch('/api/presets', { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.ok ? r.json() : {})
        .then(p => {
          PRESETS = p || {};
          updatePresetInfoCard(mode, preset, state ? { ...(state.settings || {}), edgeLabel: state.edgeLabel } : null);
        })
        .catch(() => {});

      if (!sessionStart) sessionStart = Date.now();
      renderCandleChart();
      startDurationTimer();
      hasShownApp = true;
    }

    applyState(state);
  }

  function showLoginScreen() {
    document.getElementById('appScreen').classList.add('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
  }

  function showLoginError(msg) {
    const el = document.getElementById('loginError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearLoginError() {
    const el = document.getElementById('loginError');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function showSignupError(msg) {
    const el = document.getElementById('signupError');
    el.textContent = msg;
    el.classList.remove('hidden');
  }

  function clearSignupError() {
    const el = document.getElementById('signupError');
    el.textContent = '';
    el.classList.add('hidden');
  }

  function applyState(state) {
    if (!state) return;
    syncModePresetUI(state.mode, state.preset);
    hydrateSettingsInputs(state.settings, { force: !settingsDirty });
    updatePresetInfoCard(state.mode, state.preset, { ...(state.settings || {}), edgeLabel: state.edgeLabel });
    syncAutoEdgeButton(state.autoEdgeEnabled, state.edgeLabel);
    if (state.tradeHistory) refreshTradesTable(state.tradeHistory);
    updateStats(state);
    updateConnPill(state.connected);
    if (state.market) {
      document.getElementById('marketSelect').value = state.market;
      document.getElementById('statusMarket').textContent = state.market;
    }
    const overseerAction = state?.overseer?.lastAction || '';
    if (overseerAction && overseerAction !== lastOverseerActionSeen) {
      lastOverseerActionSeen = overseerAction;
      addLog(`Overseer: ${overseerAction}`, 'info');
    }
    const diag = state?.overseerDiagnostics || {};
    const diagMsg = [diag.regime?.regime, diag.riskGate?.code, diag.lossReview?.dominantMode, diag.qualityScore].filter((v) => v !== undefined && v !== null && v !== '').join('|');
    if (diagMsg && diagMsg !== lastOverseerDiagSeen) {
      lastOverseerDiagSeen = diagMsg;
      addLog(`Overseer diagnostics → regime: ${diag.regime?.regime || 'n/a'} · risk: ${diag.riskGate?.code || 'n/a'} · quality: ${diag.qualityScore || 0}`, 'info');
    }
    sessionStart = state.sessionStartedAt || sessionStart || Date.now();
  }

  function applyBotState(data = {}) {
    botStatus = data.status || (data.running ? 'running' : 'ready');
    updateStatusBanner(botStatus);
    setStatCard('scRunning', formatStatusValue(botStatus), statusClass(botStatus));
    const startBtn = document.getElementById('startBotBtn');
    if (startBtn) startBtn.classList.toggle('running', botStatus === 'running');
    if (botStatus === 'running' && !sessionStart) sessionStart = Date.now();
  }

  function syncModePresetUI(nextMode, nextPreset) {
    if (nextMode) mode = nextMode;
    if (nextPreset) preset = nextPreset;

    document.querySelectorAll('.mode-card').forEach((card) => {
      card.classList.toggle('active-mode', card.dataset.mode === mode);
    });

    document.querySelectorAll('.preset-item').forEach((item) => {
      item.classList.toggle('active-preset', item.dataset.preset === preset);
    });

    const settingsInputIds = [
      'cfgStake','cfgMaxStake','cfgDuration','cfgDurationUnit','cfgStopLoss','cfgTakeProfit','cfgMaxLossStreak','cfgMaxTrades','cfgWinMult','cfgLossMult','cfgCooldown','cfgBias50','cfgBias100','cfgSample',
      'cfgFastPeriod','cfgSlowPeriod','cfgTicksConfirm','cfgOverBarrier','cfgUnderBarrier','cfgDigitBias','cfgDigitWindow','cfgDigits50','cfgDigits100','cfgDigits200',
      'cfgAccTicks','cfgAccBias','cfgAccStep','cfgAccTarget','cfgAccPullback','cfgAccEmaFast','cfgAccEmaSlow'
    ];
    settingsInputIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (!pendingSettingsSave) settingsDirty = true;
      });
    });
    updatePresetSubs();
    syncStakeInputForMode();
    updateGameAdditions(lastStats || {});
  }

  function hydrateSettingsInputs(settings, options = {}) {
    const { force = false } = options;
    if (!settings) return;
    if (settingsDirty && !force) return;
    document.getElementById('cfgStake').value         = settings.stakeAmount ?? (mode === 'accumulator' ? 1 : 0.35);
    document.getElementById('cfgMaxStake').value      = settings.maxStake ?? 100;
    document.getElementById('cfgDuration').value      = settings.duration ?? 1;
    document.getElementById('cfgDurationUnit').value  = settings.durationUnit ?? 't';
    document.getElementById('cfgStopLoss').value      = settings.stopLossPct ?? 15;
    document.getElementById('cfgTakeProfit').value    = settings.takeProfitPct ?? 20;
    document.getElementById('cfgMaxLossStreak').value = settings.maxLossStreak ?? 5;
    document.getElementById('cfgMaxTrades').value     = settings.maxTradesPerSession ?? 50;
    document.getElementById('cfgWinMult').value       = settings.winMultiplier ?? 1;
    document.getElementById('cfgLossMult').value      = settings.lossMultiplier ?? 1;
    document.getElementById('cfgCooldown').value      = settings.cooldownMs ?? 1200;
    document.getElementById('cfgBias50').value        = settings.entryFilter?.thresholds?.[50] ?? 58;
    document.getElementById('cfgBias100').value       = settings.entryFilter?.thresholds?.[100] ?? 55;
    document.getElementById('cfgSample').value        = settings.entryFilter?.minSampleSize ?? 100;
    syncStakeInputForMode();
  }

  // ─── Connection ───────────────────────────────────────────────
  function connectDeriv() {
    const t = document.getElementById('apiToken').value.trim();
    requestDerivConnect(t, false);
  }

  function disconnectDeriv() {
    pendingDerivToken = null;
    send('disconnect_deriv');
  }

  function setMarket(market) {
    send('set_market', { market });
    setStatCard('scMarket', market);
    document.getElementById('statusMarket').textContent = market;
  }

  function startTicks() {
    const market = document.getElementById('marketSelect').value;
    send('start_ticks', { market });
    addLog(`Subscribing to ticks: ${market}`, 'info');
  }

  function stopTicks() {
    send('stop_ticks');
    addLog('Tick subscription stopped', 'warn');
  }

  function startBot() {
    send('start_bot');
  }

  function stopBot() {
    send('stop_bot');
  }

  function toggleAutoEdge() {
    send('set_auto_edge', { enabled: !autoEdgeEnabled });
  }

  function resetSession() {
    send('reset_session');
    sessionStart = Date.now();
    bestStreak = 0;
    worstDrawdown = 0;
    document.getElementById('rpBestStreak').textContent = '0';
    document.getElementById('rpDrawdown').textContent = '$0.00';
    document.getElementById('tradesBody').innerHTML = '';
  }

  function resetAnalyzer() {
    send('reset_analyzer');
    digits = [];
    ticks  = [];
    updateDigitDisplay([]);
  }

  function selectMode(el) {
    mode = el.dataset.mode;
    syncModePresetUI(mode, preset);
    send('set_mode', { mode, preset });
  }

  function selectPreset(el) {
    preset = el.dataset.preset;
    syncModePresetUI(mode, preset);
    send('set_mode', { mode, preset });
  }

  function saveSettings() {
    const cfg = compactPayload({
      stakeAmount: mode === 'accumulator' ? Math.max(1, optionalNumber('cfgStake') ?? 1) : optionalNumber('cfgStake'),
      maxStake: optionalNumber('cfgMaxStake'),
      duration: optionalNumber('cfgDuration', parseInt),
      durationUnit: document.getElementById('cfgDurationUnit').value,
      stopLossPct: optionalNumber('cfgStopLoss'),
      takeProfitPct: optionalNumber('cfgTakeProfit'),
      maxLossStreak: optionalNumber('cfgMaxLossStreak', parseInt),
      maxTradesPerSession: optionalNumber('cfgMaxTrades', parseInt),
      winMultiplier: optionalNumber('cfgWinMult'),
      lossMultiplier: optionalNumber('cfgLossMult'),
      cooldownMs: optionalNumber('cfgCooldown', parseInt),
      bias50Threshold: optionalNumber('cfgBias50'),
      bias100Threshold: optionalNumber('cfgBias100'),
      minSampleSize: optionalNumber('cfgSample', parseInt)
    });
    pendingSettingsSave = true;
    send('update_settings', cfg);

    const indicatorPayload = { mode, preset, ...cfg };
    if (mode === 'rise_fall') {
      indicatorPayload.fastPeriod = optionalNumber('cfgFastPeriod', parseInt);
      indicatorPayload.slowPeriod = optionalNumber('cfgSlowPeriod', parseInt);
      indicatorPayload.minTicksConfirm = optionalNumber('cfgTicksConfirm', parseInt);
    }
    if (mode === 'over_under') {
      indicatorPayload.overBarrier = optionalNumber('cfgOverBarrier', parseInt);
      indicatorPayload.underBarrier = optionalNumber('cfgUnderBarrier', parseInt);
      indicatorPayload.minBiasPct = optionalNumber('cfgDigitBias');
      indicatorPayload.window = optionalNumber('cfgDigitWindow', parseInt);
    }
    if (mode === 'digits') {
      indicatorPayload.windows = [50,100,200];
      indicatorPayload.thresholds = {
        50: optionalNumber('cfgDigits50'),
        100: optionalNumber('cfgDigits100'),
        200: optionalNumber('cfgDigits200')
      };
    }
    if (mode === 'accumulator') {
      indicatorPayload.minimumTicks = optionalNumber('cfgAccTicks', parseInt);
      indicatorPayload.minTrendBiasPct = optionalNumber('cfgAccBias');
      indicatorPayload.stepPct = optionalNumber('cfgAccStep');
      indicatorPayload.targetPct = optionalNumber('cfgAccTarget');
      indicatorPayload.pullbackPct = optionalNumber('cfgAccPullback');
      indicatorPayload.emaFast = optionalNumber('cfgAccEmaFast', parseInt);
      indicatorPayload.emaSlow = optionalNumber('cfgAccEmaSlow', parseInt);
      indicatorPayload.enabled = true;
      indicatorPayload.notes = 'Accumulator engine tuned by Overseer';
    }
    send('update_indicator_settings', compactPayload(indicatorPayload));
  }

  function loadPresetToSettings() {
    const p = PRESETS[mode]?.[preset];
    if (!p) return;
    settingsDirty = false;
    hydrateSettingsInputs(p, { force: true });
  }

  // ─── Admin ────────────────────────────────────────────────────
  async function loadAdminUsers() {
    const res = await fetch('/api/admin/users', { headers: { Authorization: `Bearer ${token}` } });
    const users = await res.json();
    const body = document.getElementById('adminBody');
    body.innerHTML = '';
    users.forEach(u => {
      const exp = u.expiresAt ? new Date(u.expiresAt).toLocaleDateString() : 'No limit';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.username}</td>
        <td>${u.role}</td>
        <td>Lvl ${u.level || 1}</td>
        <td>${new Date(u.createdAt).toLocaleDateString()}</td>
        <td>${exp}</td>
        <td>
          <button class="btn-ghost-sm" onclick="App.setUserExpiry('${u.id}')">Set Expiry</button>
          <button class="btn-red" style="font-size:11px;padding:4px 10px;margin-left:4px;" onclick="App.disableUser('${u.id}')">Disable</button>
        </td>
      `;
      body.appendChild(tr);
    });
  }

  async function setUserExpiry(userId) {
    const days = parseInt(prompt('Set expiry in days from now (0 = no limit):'));
    if (isNaN(days)) return;
    const expiresAt = days > 0 ? Date.now() + days * 86400000 : null;
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ expiresAt })
    });
    loadAdminUsers();
  }

  async function disableUser(userId) {
    if (!confirm('Disable this user?')) return;
    await fetch(`/api/admin/users/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ disabled: true, expiresAt: Date.now() })
    });
    loadAdminUsers();
  }

  // ─── UI updates ───────────────────────────────────────────────
  function updateConnPill(connected) {
    const dot  = document.getElementById('connDot');
    const lbl  = document.getElementById('connLabel');
    if (!dot) return;
    dot.classList.toggle('connected', !!connected);
    lbl.textContent = connected ? 'Connected' : 'Disconnected';
  }

  function updateBalance(bal) {
    const v = parseFloat(bal).toFixed(2);
    document.getElementById('topBalance').textContent = `$${v}`;
    setStatCard('scBalance', `$${v}`, 'green');
  }

  function updateStats(data) {
    if (!data) return;
    lastStats = data;
    applyBotState(data);
    syncAutoEdgeButton(data.autoEdgeEnabled, data.edgeLabel);
    setStatCard('scMarket',  data.market || '');
    if (data.market) document.getElementById('statusMarket').textContent = data.market;
    setStatCard('scBalance', `$${parseFloat(data.balance||0).toFixed(2)}`, 'green');
    setStatCard('scPnl',     formatSignedMoney(data.sessionPnl || 0), (data.sessionPnl || 0) >= 0 ? 'green' : 'red');
    setStatCard('scPeak',    `+$${parseFloat(data.peakPnl||0).toFixed(2)}`, 'green');
    setStatCard('scStake',   `$${parseFloat(data.currentStake||1).toFixed(2)}`);
    setStatCard('scWins',    data.wins||0, 'green');
    setStatCard('scLosses',  data.losses||0, 'red');
    setStatCard('scLossStreak', data.lossStreak||0, (data.lossStreak||0) >= 3 ? 'red' : '');
    setStatCard('scTrades',  data.trades||0);

    // Status stat bar
    const wr = data.winRate || '0.0';
    document.getElementById('ssWinRate').textContent  = `${wr}%`;
    document.getElementById('ssTrades').textContent   = data.trades || 0;
    document.getElementById('ssStreak').textContent   = `${data.lossStreak||0}`;
    const pnl = parseFloat(data.sessionPnl||0);
    document.getElementById('ssPnl').textContent      = formatSignedMoney(pnl);
    document.getElementById('ssPnl').className        = 'ss-val ' + (pnl >= 0 ? 'green' : 'red');

    // Right panel P&L
    document.getElementById('rpPnl').textContent = formatSignedMoney(pnl);
    document.getElementById('rpPnl').className   = 'pnl-big ' + (pnl < 0 ? 'neg' : '');
    const bal = parseFloat(data.balance||1000);
    const pct = parseFloat(data.balanceReturnPct ?? '0');
    document.getElementById('rpPnlPct').textContent = `${pct > 0 ? '+' : pct < 0 ? '-' : ''}${Math.abs(pct).toFixed(1)}%`;
    document.getElementById('rpTrades').textContent = data.trades || 0;
    document.getElementById('rpPeak').textContent   = `+$${parseFloat(data.peakPnl||0).toFixed(2)}`;
    document.getElementById('rpWins').textContent   = data.wins || 0;
    document.getElementById('rpLosses').textContent = data.losses || 0;
    document.getElementById('rpWinRate').textContent = `${wr}%`;

    // Win rate circle
    const wrNum = parseFloat(wr) / 100;
    const circ = 144.5;
    const offset = circ - circ * wrNum;
    const circle = document.getElementById('winRateCircle');
    if (circle) circle.style.strokeDashoffset = offset;

    if (data.lossStreak > bestStreak) {
      bestStreak = data.lossStreak;
      document.getElementById('rpBestStreak').textContent = bestStreak;
    }

    // Drawdown
    const dd = Math.min(0, pnl);
    if (dd < worstDrawdown) {
      worstDrawdown = dd;
      document.getElementById('rpDrawdown').textContent = `$${Math.abs(dd).toFixed(2)}`;
    }

    // Risk meter
    const riskPct = Math.min(100, Math.abs(pnl) / bal * 500);
    document.getElementById('riskFill').style.width = `${riskPct}%`;
    const rl = document.getElementById('riskLabel');
    if (riskPct < 30) { rl.textContent = 'LOW';  rl.style.color = 'var(--green)'; }
    else if (riskPct < 65) { rl.textContent = 'MODERATE'; rl.style.color = 'var(--gold)'; }
    else { rl.textContent = 'HIGH'; rl.style.color = 'var(--red)'; }

    // XP
    if (data.xp !== undefined) updateXP(data.xp, data.level);
    if (data.sessionStartedAt) sessionStart = data.sessionStartedAt;
    updateGameAdditions(data);
  }

  function updateXP(xp, level) {
    const lvl = level || 1;
    const cur = XP_THRESHOLDS[lvl - 1] || 0;
    const next = XP_THRESHOLDS[lvl] || XP_THRESHOLDS[XP_THRESHOLDS.length - 1];
    const pct = Math.min(100, ((xp - cur) / (next - cur)) * 100);

    document.getElementById('topLevel').textContent = `LVL ${lvl}`;
    document.getElementById('xpFill').style.width   = `${pct}%`;
    document.getElementById('xpText').textContent   = `${xp} XP`;

    const names = ['','Rookie','Analyst','Sniper','Strategist','Mastermind','Phantom','Legend'];
    const ring = document.getElementById('avatarRing');
    if (lvl >= 3 && ring) ring.classList.add('visible');
  }

  function updateStatusBanner(state) {
    const dot   = document.getElementById('statusDot');
    const label = document.getElementById('statusLabel');
    if (!dot) return;
    dot.className = 'status-dot ' + state;
    const map = { ready:'READY', running:'RUNNING', stopped:'STOPPED', live:'LIVE', won:'WON', lost:'LOST' };
    label.textContent = map[state] || state.toUpperCase();
    const colorMap = { ready:'', running:'var(--blue)', stopped:'var(--red)', live:'var(--blue)', won:'var(--green)', lost:'var(--red)' };
    label.style.color = colorMap[state] || '';
  }

  function handleTradeResult(data) {
    const won = data.result === 'won';
    updateStatusBanner(won ? 'won' : 'lost');
    if (statusTimer) clearTimeout(statusTimer);
    statusTimer = setTimeout(() => updateStatusBanner(botStatus), 3000);

    // Prepend to trades table
    const body = document.getElementById('tradesBody');
    const tr   = document.createElement('tr');
    const t    = new Date(data.time);
    const timeStr = t.toTimeString().substring(0,8);
    const pnl    = parseFloat(data.profit || 0);
    const stake  = parseFloat(data.stake || 1);
    const payout = parseFloat(data.payout ?? (stake + pnl));
    tr.innerHTML = `
      <td style="color:var(--text2)">${timeStr}</td>
      <td>${data.mode || mode}</td>
      <td>${data.direction || '—'}</td>
      <td><span class="${won?'won-dot':'lost-dot'}"></span> ${won?'WON':'LOST'}</td>
      <td>$${stake.toFixed(2)}</td>
      <td>$${Math.max(0, payout).toFixed(2)}</td>
      <td style="color:${won?'var(--green)':'var(--red)'}">${formatSignedMoney(pnl)}</td>
    `;
    body.insertBefore(tr, body.firstChild);
    while (body.children.length > 20) body.removeChild(body.lastChild);

    // Show result overlay
    const overlay = document.getElementById('resultOverlay');
    document.getElementById('resultIcon').textContent   = won ? '🎯' : '💥';
    document.getElementById('resultTitle').textContent  = won ? 'YOU WON!' : 'LOST';
    document.getElementById('resultTitle').className    = 'result-title ' + (won ? 'won' : 'lost');
    const overlayStake = parseFloat(data.stake || 1);
    const overlayPayout = parseFloat(data.payout ?? (overlayStake + parseFloat(data.profit || 0)));
    document.getElementById('resultAmount').textContent = `${formatSignedMoney(data.profit || 0)} profit`;
    document.getElementById('resultAmount').style.color = won ? 'var(--green)' : 'var(--red)';
    document.getElementById('resultXp').textContent     = `Stake $${overlayStake.toFixed(2)} · Payout $${Math.max(0, overlayPayout).toFixed(2)} · ⚡ +${won?25:5} XP earned`;
    overlay.classList.remove('hidden');
    setTimeout(() => overlay.classList.add('hidden'), 3000);
  }

  function refreshTradesTable(history) {
    const body = document.getElementById('tradesBody');
    body.innerHTML = '';
    history.slice(0, 20).forEach(data => {
      const won = data.result === 'won';
      const tr  = document.createElement('tr');
      const t   = new Date(data.time);
      const stake = parseFloat(data.stake || 1);
      const profit = parseFloat(data.profit || 0);
      const payout = parseFloat(data.payout ?? (stake + profit));
      tr.innerHTML = `
        <td style="color:var(--text2)">${t.toTimeString().substring(0,8)}</td>
        <td>${data.mode || '—'}</td>
        <td>${data.direction || '—'}</td>
        <td><span class="${won?'won-dot':'lost-dot'}"></span> ${won?'WON':'LOST'}</td>
        <td>$${stake.toFixed(2)}</td>
        <td>$${Math.max(0, payout).toFixed(2)}</td>
        <td style="color:${won?'var(--green)':'var(--red)'}">${formatSignedMoney(profit)}</td>
      `;
      body.appendChild(tr);
    });
  }

  // ─── Tick / digit display ─────────────────────────────────────
  function updateTickDisplay(price, lastDigit, analyzer) {
    document.getElementById('statusTick').textContent   = `#${tickCount.toLocaleString()}`;
    document.getElementById('priceBadge').textContent   = parseFloat(price).toFixed(2);
    document.getElementById('aLastDigit').textContent   = lastDigit;

    if (!analyzer) return;

    // Sample + readiness
    const sampleNum = parseInt((analyzer.sample || '0').split('/')[0]);
    const maxSample = Math.max(1, parseInt(analyzer.requiredSample || (analyzer.sample || '1').split('/')[1] || 200, 10));
    document.getElementById('aSample').textContent     = analyzer.sample || '–';
    document.getElementById('aReady').textContent      = analyzer.ready ? 'Yes' : 'No';
    document.getElementById('aReady').style.color      = analyzer.ready ? 'var(--green)' : 'var(--text2)';
    document.getElementById('readinessFill').style.width = `${Math.min(100, sampleNum/maxSample*100)}%`;
    document.getElementById('aStreak').textContent     = `${analyzer.streakType} x${analyzer.streak}`;

    // Signal badge
    const sig = analyzer.signal;
    const badge = document.getElementById('badgeSignal');
    if (sig?.trade) {
      badge.textContent = `TRADE: ${sig.direction}`;
      badge.className   = 'badge-signal trade';
    } else {
      badge.textContent = 'NO TRADE';
      badge.className   = 'badge-signal';
    }
    document.getElementById('ssSignal').textContent = sig?.trade ? `${sig.direction}` : 'WAIT';
    document.getElementById('scSignal').textContent = formatSignalReason(sig?.reason || '–');

    // Digit grid (last 20)
    updateDigitDisplay(digits.slice(-20));

    // Bias meters
    if (analyzer.w50) {
      document.getElementById('b50even').textContent  = `E ${analyzer.w50.evenPct}%`;
      document.getElementById('b50odd').textContent   = `O ${analyzer.w50.oddPct}%`;
      document.getElementById('bias50fill').style.width = `${analyzer.w50.evenPct}%`;
      document.getElementById('b50high').textContent  = `H ${analyzer.w50.highPct}%`;
      document.getElementById('b50low').textContent   = `L ${analyzer.w50.lowPct}%`;
      document.getElementById('biasHLfill').style.width = `${analyzer.w50.highPct}%`;
    }
    if (analyzer.w100) {
      document.getElementById('b100even').textContent = `E ${analyzer.w100.evenPct}%`;
      document.getElementById('b100odd').textContent  = `O ${analyzer.w100.oddPct}%`;
      document.getElementById('bias100fill').style.width = `${analyzer.w100.evenPct}%`;
    }
  }

  function updateDigitDisplay(digs) {
    const grid = document.getElementById('digitsGrid');
    if (!grid) return;
    grid.innerHTML = '';
    digs.forEach((d, i) => {
      const cell = document.createElement('div');
      const isFresh = i === digs.length - 1;
      cell.className = 'digit-cell' + (d%2===0?' even':' odd') + (isFresh?' fresh':'');
      cell.textContent = d;
      grid.appendChild(cell);
    });
  }

  // ─── Candle chart ─────────────────────────────────────────────
  function addCandle(c) {
    const last = candles[candles.length - 1];
    if (last && last.time === c.time) {
      candles[candles.length - 1] = c;
    } else {
      candles.push(c);
    }
    if (candles.length > 40) candles.shift();
    renderCandleChart();
  }

  function renderCandleChart() {
    const chart = document.getElementById('candleChart');
    if (!chart || candles.length === 0) return;
    chart.innerHTML = '';

    const cHeight = chart.clientHeight || 160;
    const allLows  = candles.map(c => c.low);
    const allHighs = candles.map(c => c.high);
    const minP = Math.min(...allLows);
    const maxP = Math.max(...allHighs);
    const range = maxP - minP || 1;
    const pad = 10;

    candles.forEach((c, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'candle-wrap';
      const isBull = c.close >= c.open;
      const bodyTop    = ((maxP - Math.max(c.open, c.close)) / range) * (cHeight - pad*2) + pad;
      const bodyBot    = ((maxP - Math.min(c.open, c.close)) / range) * (cHeight - pad*2) + pad;
      const bodyH      = Math.max(2, bodyBot - bodyTop);
      const wickTopPx  = ((maxP - c.high) / range) * (cHeight - pad*2) + pad;
      const wickBotPx  = ((maxP - c.low)  / range) * (cHeight - pad*2) + pad;

      // Upper wick
      const wu = document.createElement('div');
      wu.className = 'candle-wick';
      wu.style.top    = `${wickTopPx}px`;
      wu.style.height = `${bodyTop - wickTopPx}px`;

      // Body
      const body = document.createElement('div');
      body.className = `candle-body ${isBull ? 'bull' : 'bear'}`;
      body.style.position = 'absolute';
      body.style.top    = `${bodyTop}px`;
      body.style.height = `${bodyH}px`;
      body.style.width  = '65%';

      // Lower wick
      const wd = document.createElement('div');
      wd.className = 'candle-wick';
      wd.style.top    = `${bodyBot}px`;
      wd.style.height = `${wickBotPx - bodyBot}px`;

      wrap.style.position = 'relative';
      wrap.appendChild(wu);
      wrap.appendChild(body);
      wrap.appendChild(wd);
      chart.appendChild(wrap);
    });
  }

  // ─── Preset subs ──────────────────────────────────────────────
  function updatePresetSubs() {
    const modeMap = {
      rise_fall: { balanced: 'EMA cross · Fixed stake', aggressive: 'Bollinger · Martingale 2x', disciplined: 'Tick momentum · Anti-mart' },
      over_under:{ balanced: 'Over 4 · Histogram 60%',  aggressive: 'Over 4 · Histogram 65%',   disciplined: 'Under 5 · PLS 1.3x' },
      digits:    { balanced: '50+100 tick bias',          aggressive: '50 tick · Martingale 2x',  disciplined: '100+200 tick strict' },
      accumulator:{ balanced: 'Trend ladder · 0.35% step', aggressive: 'Sprint ladder · 0.45% step', disciplined: 'Calm ladder · 0.25% step' }
    };
    const subs = modeMap[mode] || modeMap.rise_fall;
    document.getElementById('presetSubBalanced').textContent   = subs.balanced;
    document.getElementById('presetSubAggressive').textContent = subs.aggressive;
    document.getElementById('presetSubDisciplined').textContent= subs.disciplined;
  }

  function updatePresetInfoCard(m, p, settings) {
    const data = PRESETS[m]?.[p];
    if (!data && !settings) return;
    const d = data || settings;
    document.getElementById('piName').textContent = d.name || `${p} preset`;
    document.getElementById('piDesc').textContent = d.description || '';
    const tags = document.getElementById('piTags');
    tags.innerHTML = '';
    const addTag = (txt) => { const s = document.createElement('span'); s.className='pi-tag'; s.textContent=txt; tags.appendChild(s); };
    addTag(d.stakeMode || 'fixed');
    if (d.stopLossPct)   addTag(`SL ${d.stopLossPct}%`);
    if (d.takeProfitPct) addTag(`TP ${d.takeProfitPct}%`);
    if (d.maxLossStreak) addTag(`Max streak ${d.maxLossStreak}`);
    if (settings?.edgeLabel) addTag(settings.edgeLabel);
  }

  // ─── Session timer ────────────────────────────────────────────
  function startDurationTimer() {
    if (durationTimerId) return;
    durationTimerId = setInterval(() => {
      const mins = Math.floor((Date.now() - (sessionStart||Date.now())) / 60000);
      document.getElementById('rpDuration').textContent = `${mins}m`;
    }, 10000);
  }

  // ─── Helpers ──────────────────────────────────────────────────
  function setStatCard(id, val, cls) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.className   = 'sc-value' + (cls ? ` ${cls}` : '');
  }

  function formatSignedMoney(value) {
    const amount = parseFloat(value || 0);
    const sign = amount > 0 ? '+' : amount < 0 ? '-' : '';
    return `${sign}$${Math.abs(amount).toFixed(2)}`;
  }

  function getModeLabel(value = mode) {
    return MODE_LABELS[value] || 'Arena';
  }

  function getPresetLabel(value = preset) {
    return PRESET_LABELS[value] || String(value || 'Preset');
  }

  function pluralize(count, singular) {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
  }

  function formatStatusValue(status) {
    const map = { running: 'RUNNING', stopped: 'STOPPED', ready: 'READY' };
    return map[status] || String(status || 'ready').toUpperCase();
  }

  function statusClass(status) {
    if (status === 'running') return 'green';
    if (status === 'stopped') return 'red';
    return '';
  }

  function syncAutoEdgeButton(enabled = autoEdgeEnabled, edgeLabel) {
    autoEdgeEnabled = enabled !== false;
    const btn = document.getElementById('autoEdgeBtn');
    if (!btn) return;

    btn.classList.toggle('inactive', !autoEdgeEnabled);
    const label = document.getElementById('autoEdgeLabel');
    if (label) label.textContent = autoEdgeEnabled ? 'AUTO EDGE ON' : 'AUTO EDGE OFF';

    const hint = document.getElementById('autoEdgeHint');
    if (!hint) return;

    hint.textContent = autoEdgeEnabled
      ? `${edgeLabel || getPresetLabel()} can rotate itself when the current edge weakens.`
      : `Auto edge is locked. ${edgeLabel || getPresetLabel()} will stay active until you turn it back on.`;
  }

  function updateGameAdditions(data = {}) {
    const challengeTitle = document.getElementById('challengeTitle');
    if (!challengeTitle) return;

    const wins = Number(data.wins || 0);
    const trades = Number(data.trades || 0);
    const edgeSession = data.edgeSession || {};
    const activeEdgeLabel = data.edgeLabel || getPresetLabel();
    const autoEdge = data.autoEdgeEnabled !== undefined ? data.autoEdgeEnabled : autoEdgeEnabled;
    const questMap = {
      rise_fall: {
        balanced: { title: 'Trend Quest', text: 'Bank 3 confirmed trend wins before the edge review.', goal: 3, metric: 'wins', reward: '+150 XP' },
        aggressive: { title: 'Breakout Rush', text: 'Complete 5 rise/fall entries while Quick Fire scouts momentum bursts.', goal: 5, metric: 'trades', reward: '+175 XP' },
        disciplined: { title: 'Calm Current', text: 'Stack 2 careful rise/fall wins with the slow setup in control.', goal: 2, metric: 'wins', reward: '+120 XP' }
      },
      over_under: {
        balanced: { title: 'Digit Hunter', text: 'Log 4 over/under reads while the bias engine searches the stronger side.', goal: 4, metric: 'trades', reward: '+130 XP' },
        aggressive: { title: 'Threshold Sprint', text: 'Fire off 6 over/under entries while the edge scanner keeps pressure-testing digits.', goal: 6, metric: 'trades', reward: '+180 XP' },
        disciplined: { title: 'Low Side Guard', text: 'Land 3 patient over/under wins before the next review cycle.', goal: 3, metric: 'wins', reward: '+140 XP' }
      },
      digits: {
        balanced: { title: 'Parity Lab', text: 'Finish 3 digit wins while the 50/100 tick bias stays aligned.', goal: 3, metric: 'wins', reward: '+150 XP' },
        aggressive: { title: 'Rapid Sequence', text: 'Complete 5 digit trades while Quick Fire stress-tests the parity edge.', goal: 5, metric: 'trades', reward: '+170 XP' },
        disciplined: { title: 'Quiet Precision', text: 'Lock in 2 clean digit wins with the calm preset holding the line.', goal: 2, metric: 'wins', reward: '+120 XP' }
      }
    };
    const quest = questMap[mode]?.[preset] || questMap.rise_fall.balanced;
    const questValue = quest.metric === 'wins' ? wins : trades;
    const questProgress = Math.max(0, Math.min(quest.goal, questValue));

    challengeTitle.textContent = quest.title;
    document.getElementById('challengeText').textContent = quest.text;
    document.getElementById('challengeFill').style.width = `${(questProgress / quest.goal) * 100}%`;
    document.getElementById('challengeProgress').textContent = `${questProgress} / ${quest.goal}`;
    document.getElementById('challengeReward').textContent = questProgress >= quest.goal ? 'Quest cleared' : quest.reward;

    const badge = document.getElementById('badgeMode');
    if (badge) badge.textContent = activeEdgeLabel;

    const bonusTitle = document.getElementById('bonusTitle');
    const bonusText = document.getElementById('bonusText');
    const bonusFill = document.getElementById('bonusFill');
    const bonusProgress = document.getElementById('bonusProgress');
    const bonusReward = document.getElementById('bonusReward');
    if (!bonusTitle || !bonusText || !bonusFill || !bonusProgress || !bonusReward) return;

    if (!autoEdge) {
      bonusTitle.textContent = `${getModeLabel()} Edge Locked`;
      bonusText.textContent = `Auto edge is off. The bot will hold ${activeEdgeLabel} until you turn rotation back on.`;
      bonusFill.style.width = '0%';
      bonusProgress.textContent = 'MANUAL';
      bonusReward.textContent = `${getPresetLabel(preset)} held steady`;
      return;
    }

    const reviewProgress = Math.max(0, Math.min(EDGE_REVIEW_WINDOW, Number(edgeSession.trades || 0)));
    const reviewRemaining = Math.max(0, EDGE_REVIEW_WINDOW - reviewProgress);
    const huntFocus = {
      rise_fall: 'trend direction',
      over_under: 'digit threshold',
      digits: 'parity bias',
      accumulator: 'trend ladder'
    };

    bonusTitle.textContent = `${getModeLabel()} Edge Hunt`;
    bonusText.textContent = `Auto edge is testing ${activeEdgeLabel} to lock onto the strongest ${huntFocus[mode] || 'setup'} for this session.`;
    bonusFill.style.width = `${(reviewProgress / EDGE_REVIEW_WINDOW) * 100}%`;
    bonusProgress.textContent = `${reviewProgress} / ${EDGE_REVIEW_WINDOW}`;
    bonusReward.textContent = reviewRemaining === 0
      ? `${Number(edgeSession.wins || 0)}W / ${Number(edgeSession.losses || 0)}L • ${formatSignedMoney(edgeSession.pnl || 0)}`
      : `Next review in ${pluralize(reviewRemaining, 'trade')}`;
  }

  function syncViewportMode() {
    const prefersMobileViewport = window.innerWidth <= MOBILE_BREAKPOINT;
    const coarsePointer = window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 1024;
    const mobileAgent = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent || '');
    document.body.classList.toggle('is-mobile', prefersMobileViewport || coarsePointer || mobileAgent);
  }


function formatSignalReason(reason = '') {
  const value = String(reason || '').trim();
  if (!value) return '–';
  const legacyMap = {
    digit_histogram: 'Digit histogram',
    digit_histogram_analysis: 'Digit histogram',
    even_odd_bias: 'Parity bias',
    even_odd_3ma: 'Parity bias',
    differs_rotation: 'Differs rotation',
    hot_digit_cluster: 'Hot digit cluster',
    ema_cross: 'EMA cross',
    ema_macd_cross: 'EMA + MACD',
    bollinger_breakout: 'BB bounce',
    bollinger_hull_breakout: 'BB + Hull',
    tick_momentum: 'Trend pullback',
    trend_pullback_continuation: 'Trend pullback'
  };
  const match = value.match(/^Waiting for setup \(([^)]+)\)$/i);
  if (match) {
    const label = legacyMap[match[1]] || match[1].replace(/_/g, ' ');
    return `Waiting for ${label} setup`;
  }
  if (/^Unknown strategy$/i.test(value)) return 'Waiting for setup';
  return value;
}

  function addLog(msg, type = 'info') {
    const box  = document.getElementById('logBox');
    if (!box) return;
    const line = document.createElement('div');
    line.className = `log-line ${type}`;
    const t = new Date().toTimeString().substring(0,8);
    line.innerHTML = `<span class="log-time">${t}</span>${msg}`;
    box.insertBefore(line, box.firstChild);
    while (box.children.length > 100) box.removeChild(box.lastChild);
  }

  // ─── Init ─────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    syncViewportMode();
    restoreDerivTokenInput();
    initWS();
    document.getElementById('loginPass').addEventListener('keydown', e => { if (e.key==='Enter') login(); });
    const apiTokenInput = document.getElementById('apiToken');
    if (apiTokenInput) {
      apiTokenInput.addEventListener('input', (e) => {
        localStorage.setItem('deriv_api_token', e.target.value || '');
      });
      apiTokenInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectDeriv(); });
    }
    const settingsInputIds = [
      'cfgStake','cfgMaxStake','cfgDuration','cfgDurationUnit','cfgStopLoss','cfgTakeProfit','cfgMaxLossStreak','cfgMaxTrades','cfgWinMult','cfgLossMult','cfgCooldown','cfgBias50','cfgBias100','cfgSample',
      'cfgFastPeriod','cfgSlowPeriod','cfgTicksConfirm','cfgOverBarrier','cfgUnderBarrier','cfgDigitBias','cfgDigitWindow','cfgDigits50','cfgDigits100','cfgDigits200',
      'cfgAccTicks','cfgAccBias','cfgAccStep','cfgAccTarget','cfgAccPullback','cfgAccEmaFast','cfgAccEmaSlow'
    ];
    settingsInputIds.forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      const evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (!pendingSettingsSave) settingsDirty = true;
      });
    });
    updatePresetSubs();
    window.addEventListener('resize', syncViewportMode);
    window.addEventListener('orientationchange', syncViewportMode);
  });

  return {
    login, signup, logout,
    connectDeriv, disconnectDeriv,
    startTicks, stopTicks, startBot, stopBot,
    toggleAutoEdge,
    resetSession, resetAnalyzer,
    selectMode, selectPreset,
    setMarket,
    saveSettings, loadPresetToSettings,
    loadAdminUsers, setUserExpiry, disableUser
  };
})();

// ─── Global UI helpers ────────────────────────────────────────────
function showTab(name) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.add('hidden'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.getElementById(`tab${name.charAt(0).toUpperCase()+name.slice(1)}`)?.classList.remove('hidden');
  document.querySelectorAll('.tab').forEach(t => {
    if (t.textContent.trim().toLowerCase() === name || t.getAttribute('onclick')?.includes(`'${name}'`)) {
      t.classList.add('active');
    }
  });
  if (name === 'admin') App.loadAdminUsers();
}

function toggleUserMenu() {
  const m = document.getElementById('userMenu');
  m.classList.toggle('hidden');
}
function closeUserMenu() {
  document.getElementById('userMenu').classList.add('hidden');
}
document.addEventListener('click', (e) => {
  const m = document.getElementById('userMenu');
  if (m && !m.classList.contains('hidden')) {
    if (!e.target.closest('#userMenu') && !e.target.closest('#avatarBtn')) {
      m.classList.add('hidden');
    }
  }
});

function showSignup()  { document.getElementById('signupCard').classList.remove('hidden'); }
function hideSignup()  { document.getElementById('signupCard').classList.add('hidden'); }
function closeResult() { document.getElementById('resultOverlay').classList.add('hidden'); }
function closeLevelUp(){ document.getElementById('levelUpOverlay').classList.add('hidden'); }

function showLevelUp(level, name) {
  document.getElementById('luLevel').textContent = `LEVEL ${level}`;
  document.getElementById('luTitle').textContent = name;
  document.getElementById('levelUpOverlay').classList.remove('hidden');
}

function setTf(el) {
  el.closest('.chart-chips').querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
}
