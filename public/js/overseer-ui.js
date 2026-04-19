(function () {
  const state = { missionState: null, activeLevel: 1, pollId: null, seenNoticeIds: new Set(), activePopupTimer: null, lastMissionPopupId: null, mt5Category: 'favorites', mt5Search: '', mt5Profile: null };
  function authHeaders() {
    const token = localStorage.getItem('arena_token');
    return token ? { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
  }

  async function loadMt5Profile() {
    try {
      const res = await fetch('/api/user/mt5/profile', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      state.mt5Profile = data.mt5 || null;
      hydrateMt5Profile();
    } catch (_) {}
  }

  function hydrateMt5Profile() {
    const p = state.mt5Profile || {};
    const setVal = (id, value) => { const el = document.getElementById(id); if (el && value !== undefined && value !== null && document.activeElement !== el) el.value = value; };
    setVal('userMt5BridgeInput', p.bridgeUrl || '');
    setVal('userMt5LoginInput', p.login || '');
    setVal('userMt5ServerInput', p.server || '');
    setVal('copyRiskInput', p.riskMultiplier || 1);
    setVal('userMt5AllowedSymbolsInput', Array.isArray(p.allowedSymbols) ? p.allowedSymbols.join(', ') : '');
    const follow = document.getElementById('copyFollowInput'); if (follow) follow.value = String(Boolean(p.followAdmin));
    const mirror = document.getElementById('copyMirrorInput'); if (mirror) mirror.value = String(Boolean(p.mirrorAdminTrades));
    const same = document.getElementById('copySameAsAdminInput'); if (same) same.value = String(Boolean(p.sameAsAdmin));
    const saved = document.getElementById('mt5ProfileSavedStatus'); if (saved) saved.textContent = p.login ? 'Saved' : 'Empty';
    const pass = document.getElementById('mt5PasswordSavedStatus'); if (pass) pass.textContent = p.passwordSet ? 'Stored' : 'Not set';
    const conn = document.getElementById('mt5UserConnectionStatus'); if (conn) conn.textContent = p.liveTradingEnabled ? 'Live armed' : (p.enabled ? 'Managed by Overseer' : 'Disconnected');
    const liveBtn = document.getElementById('userMt5LiveBtn'); if (liveBtn) liveBtn.textContent = p.liveTradingEnabled ? 'MT5 Live Armed' : 'Arm Live MT5';
    const liveStatus = document.getElementById('mt5TabLiveStatus'); if (liveStatus && !state.missionState) liveStatus.textContent = p.liveTradingEnabled ? 'ARMED' : 'OFF';
  }

  async function saveMt5Profile(extra = {}) {
    const body = {
      login: document.getElementById('userMt5LoginInput')?.value?.trim() || '',
      password: document.getElementById('userMt5PasswordInput')?.value || undefined,
      server: document.getElementById('userMt5ServerInput')?.value?.trim() || '',
      bridgeUrl: document.getElementById('userMt5BridgeInput')?.value?.trim() || '',
      followAdmin: document.getElementById('copyFollowInput')?.value === 'true',
      mirrorAdminTrades: document.getElementById('copyMirrorInput')?.value === 'true',
      riskMultiplier: Number(document.getElementById('copyRiskInput')?.value || 1),
      sameAsAdmin: document.getElementById('copySameAsAdminInput')?.value === 'true',
      allowedSymbols: String(document.getElementById('userMt5AllowedSymbolsInput')?.value || '').split(',').map((x) => x.trim()).filter(Boolean),
      ...extra
    };
    try {
      const res = await fetch('/api/user/mt5/profile', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
      const data = await res.json();
      state.mt5Profile = data.mt5 || state.mt5Profile;
      const passInput = document.getElementById('userMt5PasswordInput'); if (passInput) passInput.value = '';
      hydrateMt5Profile();
      return data.mt5;
    } catch (_) { return null; }
  }

  async function loadMissionState() {
    const token = localStorage.getItem('arena_token');
    if (!token) return;
    try {
      const res = await fetch('/api/mission/state', { headers: authHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      state.missionState = data.missionState;
      renderMissionState();
    } catch (_) {}
  }
  function renderMissionState() {
    const ms = state.missionState;
    if (!ms) return;
    renderPrimary(ms); renderOverseer(ms); renderLevels(ms); renderNotices(ms); renderMissionScene('missionScene', ms, false); renderMissionScene('homeMissionScene', ms, true); renderMissionScene('mt5MissionScene', ms, true); renderMt5(ms); renderQuestPopups(ms);
  }
  function renderPrimary(ms) {
    const primary = ms.primaryMission || ms.missions?.[0];
    if (!primary) return;
    const fill = primary.goal ? Math.max(0, Math.min(100, (primary.progress / primary.goal) * 100)) : 0;
    [['challengeTitle', primary.title], ['challengeText', primary.text], ['challengeProgress', `${primary.progress} / ${primary.goal}`], ['challengeReward', primary.progress >= primary.goal ? 'Quest cleared' : primary.reward]].forEach(([id, val]) => { const el = document.getElementById(id); if (el) el.textContent = val; });
    const f = document.getElementById('challengeFill'); if (f) f.style.width = `${fill}%`;
  }
  function renderOverseer(ms) {
    const phase = String(ms.overseer?.researchPhase || 'idle').toLowerCase();
    const statusMap = { detecting: 'Detecting weakness', investigating: 'Investigating edge', testing: 'Testing safer setup', recommending: 'Preparing deployment' };
    const statusText = ms.overseer?.researchMode ? (statusMap[phase] || 'Researching stronger edge') : 'Watching live session';
    const actionText = ms.overseer?.lastAction || 'Monitoring';
    ['overseerStatus', 'homeOverseerStatus', 'mt5OverseerStatus'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = statusText; });
    ['overseerAction', 'homeOverseerAction', 'mt5OverseerAction'].forEach((id) => { const el = document.getElementById(id); if (el) el.textContent = actionText; });
    const autonomy = document.getElementById('overseerAutonomy'); if (autonomy) autonomy.textContent = ms.overseer?.autonomyEnabled ? 'Autonomy ON' : 'Autonomy OFF';
    const people = { overseer:'🧑🏾‍💼', jarvis:'🧑🏾‍💻', openclaw:'🧑🏾‍🚀', risk:'🧑🏾‍✈️', strategy:'🧑🏾‍🔬', regime:'🧑🏾‍🏫', reviewer:'🧑🏾‍⚖️', memory:'🧑🏾‍🗂️' };
    const agentWrap = document.getElementById('agentRoster');
    if (agentWrap) agentWrap.innerHTML = (ms.agents || []).map(agent => `<div class="agent-pill ${agent.status || ''}"><div class="agent-pill-left"><span class="agent-emoji">${people[agent.id] || '🧑🏾'}</span><div><strong>${agent.name}</strong><span>${agent.role}</span></div></div><b>${String(agent.status || 'ready').toUpperCase()}</b></div>`).join('');
  }
  function renderLevels(ms) {
    const levels = ms.levels || [];
    const tabs = document.getElementById('missionLevelTabs');
    if (tabs) {
      tabs.innerHTML = levels.map(item => `<button class="mission-tab ${item.level === state.activeLevel ? 'active' : ''}" data-level="${item.level}">LEVEL ${item.level}</button>`).join('');
      tabs.querySelectorAll('button').forEach(btn => btn.onclick = () => { state.activeLevel = Number(btn.dataset.level); renderMissionState(); });
    }
    const board = document.getElementById('missionBoard');
    if (board) {
      const current = levels.find(item => item.level === state.activeLevel) || levels[0] || { missions: [] };
      board.innerHTML = (current.missions || []).map(m => `<div class="mission-card ${m.status || ''}"><div class="mission-head"><strong>${m.title}</strong><span>${m.execution || 'QUEUED'}</span></div><p>${m.text}</p><div class="mission-meta"><span>${m.progress}/${m.goal}</span><span>${m.reward}</span><span>${m.assignedTo}</span></div></div>`).join('') || '<div class="mission-empty">No missions on this level yet.</div>';
    }
  }
  function renderNotices(ms) {
    const noticeHtml = (ms.overseer?.notices || []).slice(0, 5).map(n => `<div class="notice ${n.severity || 'info'}"><strong>${new Date(n.at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</strong><span>${n.message}</span></div>`).join('') || '<div class="notice">No live notices yet.</div>';
    ['overseerNotices', 'homeOverseerNotices'].forEach((id) => { const el = document.getElementById(id); if (el) el.innerHTML = noticeHtml; });
  }
  function renderMt5(ms) {
    const mt5 = ms.mt5 || {}; const assistant = ms.assistant || {};
    const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
    setText('mt5VenueStatus', mt5.venueEnabled ? 'ARMED' : 'STANDBY');
    setText('mt5BridgeStatus', mt5.bridgeStatus || 'hooks_ready');
    setText('mt5ActiveSymbol', mt5.activeSymbol || 'XAUUSD');
    setText('mt5Style', mt5.style || 'SMC');
    setText('mt5Recommendation', mt5.lastRecommendation || 'No MT5 recommendation yet.');
    setText('mt5TabVenueStatus', mt5.venueEnabled ? 'ARMED' : 'STANDBY');
    setText('mt5TabBridgeStatus', mt5.bridgeConnected ? 'CONNECTED' : (mt5.bridgeStatus || 'hooks_ready'));
    setText('mt5TabLiveStatus', mt5.liveTradingEnabled ? 'ARMED' : 'OFF');
    setText('mt5TabSymbol', mt5.activeSymbol || 'XAUUSD');
    setText('mt5TabStyle', mt5.style || 'SMC');
    setText('mt5TabFocus', mt5.productFocus || 'MT5 Gold');
    setText('mt5TabRecommendation', mt5.lastRecommendation || 'No MT5 recommendation yet.');
    setText('copyLastSync', mt5.copyTrading?.lastAdminSyncAt ? new Date(mt5.copyTrading.lastAdminSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
    setText('copyModeStatus', mt5.copyTrading?.followAdmin ? 'Following admin' : 'Off');
    setText('copyLiveStatus', mt5.liveTradingEnabled ? 'Enabled' : 'Disabled');
    const notes = document.getElementById('assistantNotes'); if (notes) notes.innerHTML = (assistant.notes || []).slice(0, 5).map(n => `<div class="assistant-note"><b>${new Date(n.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b>${n.text}</div>`).join('') || '<div class="assistant-note">No saved notes yet.</div>';
    hydrateMt5Profile();

    const catalog = mt5.catalog || {};
    const categories = [
      { key: 'favorites', label: 'Favourites' },
      { key: 'commodities', label: 'Gold / Commodities' },
      { key: 'volatility', label: 'Volatility' },
      { key: 'crashBoom', label: 'Crash / Boom' },
      { key: 'step', label: 'Step' },
      { key: 'advanced', label: 'Advanced synthetics' },
      { key: 'baskets', label: 'Baskets' }
    ];
    const tabs = document.getElementById('mt5CategoryTabs');
    if (tabs) {
      tabs.innerHTML = categories.map((cat) => `<button class="mt5-cat-btn ${state.mt5Category === cat.key ? 'active' : ''}" data-key="${cat.key}">${cat.label}</button>`).join('');
      tabs.querySelectorAll('button').forEach((btn) => btn.onclick = () => { state.mt5Category = btn.dataset.key; renderMt5(ms); });
    }
    const allSymbols = Object.values(catalog).flat().filter(Boolean);
    const favs = Array.isArray(mt5.favorites) ? mt5.favorites : [];
    const search = String(state.mt5Search || '').trim().toLowerCase();
    let source = state.mt5Category === 'favorites' ? allSymbols.filter((item) => favs.includes(item.symbol)) : (catalog[state.mt5Category] || allSymbols);
    if (search) source = source.filter((item) => `${item.symbol} ${item.label}`.toLowerCase().includes(search));
    const favWrap = document.getElementById('mt5Favorites');
    if (favWrap) {
      favWrap.innerHTML = (favs.length ? favs : ['XAUUSD','Volatility 75 Index','Crash 500 Index']).map((symbol) => `<button class="mt5-fav-chip ${symbol === mt5.activeSymbol ? 'active' : ''}" data-symbol="${symbol}">${symbol}</button>`).join('');
      favWrap.querySelectorAll('button').forEach((btn) => btn.onclick = () => quickArmSymbol(btn.dataset.symbol, ms));
    }
    const results = document.getElementById('mt5SymbolResults');
    if (results) {
      results.innerHTML = source.map((item) => {
        const isFav = favs.includes(item.symbol);
        const isActive = item.symbol === mt5.activeSymbol;
        return `<div class="mt5-symbol-card ${isActive ? 'active' : ''}"><div><strong>${item.label}</strong><span>${item.family || 'symbol'}</span></div><div class="mt5-symbol-actions"><button class="btn-ghost-sm symbol-pick" data-symbol="${item.symbol}">Track</button><button class="btn-ghost-sm symbol-fav ${isFav ? 'active' : ''}" data-symbol="${item.symbol}">${isFav ? '★' : '☆'}</button></div></div>`;
      }).join('') || '<div class="mission-empty">No symbols match your search.</div>';
      results.querySelectorAll('.symbol-pick').forEach((btn) => btn.onclick = () => quickArmSymbol(btn.dataset.symbol, ms));
      results.querySelectorAll('.symbol-fav').forEach((btn) => btn.onclick = () => sendOverseerCommand('toggle_mt5_favorite', { symbol: btn.dataset.symbol }));
    }
    const searchInput = document.getElementById('mt5SymbolSearch');
    if (searchInput && !searchInput.dataset.bound) {
      searchInput.dataset.bound = 'true';
      searchInput.addEventListener('input', (e) => {
        state.mt5Search = e.target.value || '';
        if (state.missionState) renderMt5(state.missionState);
      });
    }
    if (searchInput && searchInput.value !== state.mt5Search) searchInput.value = state.mt5Search;
  }

  function quickArmSymbol(symbol, ms) {
    const symbolInput = document.getElementById('userMt5SymbolInput');
    if (symbolInput) {
      const exists = Array.from(symbolInput.options).some((opt) => opt.value === symbol);
      if (!exists) symbolInput.insertAdjacentHTML('beforeend', `<option value="${symbol}">${symbol}</option>`);
      symbolInput.value = symbol;
    }
    sendOverseerCommand('set_trade_venue', { enabled: true, symbol, style: (ms?.mt5?.style || 'SMC'), bridgeUrl: document.getElementById('userMt5BridgeInput')?.value?.trim() || undefined, accountLogin: document.getElementById('userMt5LoginInput')?.value || '', accountServer: document.getElementById('userMt5ServerInput')?.value || '' });
  }

  function renderMissionScene(targetId, ms, compact) {
    const wrap = document.getElementById(targetId); if (!wrap) return;
    const lanes = [{ key: 'queued', label: 'Queued', sub: 'Awaiting launch', left: 1.5 }, { key: 'executing', label: 'Executing', sub: 'Live in motion', left: 26 }, { key: 'validating', label: 'Validating', sub: 'Stress-testing edge', left: 50.5 }, { key: 'completed', label: 'Completed', sub: 'Archived wins', left: 75 }];
    const people = { overseer:'🧑🏾‍💼', jarvis:'🧑🏾‍💻', openclaw:'🧑🏾‍🚀', risk:'🧑🏾‍✈️', strategy:'🧑🏾‍🔬', regime:'🧑🏾‍🏫', reviewer:'🧑🏾‍⚖️', memory:'🧑🏾‍🗂️' };
    const laneWidth = 23; const html = ['<div class="scene-stars"></div><div class="scene-grid"></div><div class="scene-core"></div>'];
    lanes.forEach((lane) => html.push(`<div class="mission-lane" style="left:${lane.left}%;width:${laneWidth}%;"><h4>${lane.label}</h4><div class="lane-sub">${lane.sub}</div></div>`));
    const grouped = { queued: [], executing: [], validating: [], completed: [] };
    (ms.missions || []).forEach((mission) => { const execution = String(mission.execution || '').toUpperCase(); const status = String(mission.status || '').toLowerCase(); let key = 'queued'; if (status === 'completed' || execution === 'COMPLETED') key = 'completed'; else if (status === 'validating' || ['VALIDATING', 'VALIDATED'].includes(execution)) key = 'validating'; else if (['executing', 'researching', 'watching'].includes(status) || ['EXECUTING', 'DETECTING', 'INVESTIGATING', 'TESTING', 'RECOMMENDING', 'RESEARCHING', 'WATCHING', 'LIVE'].includes(execution)) key = 'executing'; grouped[key].push(mission); });
    (ms.agents || []).forEach((agent, index) => {
      const mission = (ms.missions || []).find(m => String(m.assignedTo || '').toLowerCase() === String(agent.id).toLowerCase()) || (ms.missions || [])[index % Math.max(1, (ms.missions || []).length)] || null;
      const execution = String(mission?.execution || '').toUpperCase();
      const status = String(mission?.status || '').toLowerCase();
      let laneIndex = 0;
      if (status === 'completed' || execution === 'COMPLETED') laneIndex = 3;
      else if (status === 'validating' || ['VALIDATING', 'VALIDATED'].includes(execution)) laneIndex = 2;
      else if (['executing', 'researching', 'watching'].includes(status) || ['EXECUTING', 'DETECTING', 'INVESTIGATING', 'TESTING', 'RECOMMENDING', 'RESEARCHING', 'WATCHING', 'LIVE'].includes(execution) || ['executing', 'researching', 'watching', 'guarding', 'scanning', 'briefing', 'reviewing', 'indexing'].includes(agent.status)) laneIndex = 1;
      const laneLeft = lanes[laneIndex].left;
      const row = Math.floor(index / 2);
      const col = index % 2;
      const x = laneLeft + 3 + col * 9 + ((index % 3) * 0.7);
      const y = 76 + row * (compact ? 58 : 70) + ((index + laneIndex) % 2) * 10;
      html.push(`<div class="walker-track" style="left:${x}%;top:${y}px;"><div class="mission-agent human walker ${agent.status || 'ready'} ${compact ? 'compact' : ''}" style="animation-delay:${(index % 5) * 0.25}s;"><div class="person-avatar">${people[agent.id] || '🧑🏾'}</div><div class="bot-name">${agent.name}</div><div class="bot-task">${mission ? mission.title : 'Standing by'}</div><div class="bot-state">${execution || String(agent.status || 'ready').toUpperCase()}</div></div></div>`);
    });
    lanes.forEach((lane) => { const count = grouped[lane.key].length; html.push(`<div class="lane-count" style="left:${lane.left + 1}%;bottom:10px;">${count} active</div>`); });
    wrap.innerHTML = html.join('');
  }

  function renderQuestPopups(ms) {
    const wrap = document.getElementById('questPopups'); if (!wrap) return; const primary = ms.primaryMission; const latestNotice = (ms.overseer?.notices || [])[0]; let popup = null;
    if (latestNotice) { const noticeId = `notice-${latestNotice.at}`; if (!state.seenNoticeIds.has(noticeId)) { state.seenNoticeIds.add(noticeId); popup = { id: noticeId, tag: 'Overseer Update', title: ms.overseer?.lastAction || 'Overseer update', body: latestNotice.message, footerLeft: latestNotice.severity || 'info', footerRight: 'now' }; } }
    if (!popup && primary) { const missionId = `mission-${primary.id}-${primary.execution}-${primary.progress}`; if (state.lastMissionPopupId !== missionId && primary.progress > 0) { state.lastMissionPopupId = missionId; popup = { id: missionId, tag: 'Mission Update', title: primary.title, body: primary.text, footerLeft: `${primary.progress}/${primary.goal}`, footerRight: primary.execution || primary.reward }; } }
    if (!popup) return; wrap.innerHTML = `<div class="quest-popup ${popup.footerLeft}"><div class="qp-top"><span class="qp-tag">${popup.tag}</span><span>${popup.footerRight}</span></div><div class="qp-title">${popup.title}</div><div class="qp-body">${popup.body}</div><div class="qp-footer"><span>${popup.footerLeft}</span><span>${popup.footerRight}</span></div></div>`; clearTimeout(state.activePopupTimer); state.activePopupTimer = setTimeout(() => { wrap.innerHTML = ''; }, 6500);
  }
  async function sendJarvisMessage() {
    const input = document.getElementById('jarvisInput'); const log = document.getElementById('jarvisLog'); const query = input?.value?.trim(); if (!query) return;
    log.insertAdjacentHTML('beforeend', `<div class="jarvis-line me">${query}</div>`); input.value = '';
    try { const res = await fetch('/api/copilot/query', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ query }) }); const data = await res.json(); log.insertAdjacentHTML('beforeend', `<div class="jarvis-line bot">${data.reply || 'Overseer has no reply yet.'}</div>`); log.scrollTop = log.scrollHeight; await loadMissionState(); } catch (_) { log.insertAdjacentHTML('beforeend', `<div class="jarvis-line bot">Overseer could not answer right now.</div>`); }
  }
  async function sendOverseerCommand(command, payload) {
    try {
      const res = await fetch('/api/overseer/command', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ command, payload: payload || {} }) });
      const data = await res.json();
      state.missionState = data.missionState;
      renderMissionState();
      return data.missionState;
    } catch (_) {
      return null;
    }
  }
  async function saveAssistantNote() {
    const input = document.getElementById('assistantNoteInput'); const text = input?.value?.trim(); if (!text) return;
    await fetch('/api/assistant/note', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ text }) }); input.value = ''; await loadMissionState();
  }
  function bootUi() {
    const sendBtn = document.getElementById('jarvisSend'); const input = document.getElementById('jarvisInput'); if (sendBtn) sendBtn.onclick = sendJarvisMessage; if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendJarvisMessage(); });
    document.querySelectorAll('[data-overseer-command]').forEach(btn => { btn.onclick = () => sendOverseerCommand(btn.dataset.overseerCommand, btn.dataset.overseerCommand === 'set_autonomy' ? { enabled: btn.dataset.enabled === 'true' } : {}); });
    const missionBtn = document.getElementById('createMissionBtn'); if (missionBtn) missionBtn.onclick = () => { const title = document.getElementById('missionTitleInput').value.trim(); if (!title) return; sendOverseerCommand('create_mission', { title, text: document.getElementById('missionTextInput').value.trim() || 'New live mission from Overseer.', level: Number(document.getElementById('missionLevelInput').value || 1), goal: Number(document.getElementById('missionGoalInput').value || 1), reward: document.getElementById('missionRewardInput').value.trim() || '+100 XP', assignedTo: document.getElementById('missionAgentInput').value || 'overseer' }); };
    const modeBtn = document.getElementById('setOverseerModeBtn'); if (modeBtn) modeBtn.onclick = () => sendOverseerCommand('set_overseer_mode', { mode: document.getElementById('overseerModeInput').value });
    const armBtn = document.getElementById('mt5ArmBtn'); if (armBtn) armBtn.onclick = () => sendOverseerCommand('set_trade_venue', { enabled: document.getElementById('mt5VenueInput').value === 'MT5', symbol: document.getElementById('mt5SymbolInput').value, style: document.getElementById('mt5StyleInput').value });
    const goldBtn = document.getElementById('mt5GoldBtn'); if (goldBtn) goldBtn.onclick = () => sendOverseerCommand('set_product_focus', { focus: 'MT5 Gold' });
    const vixBtn = document.getElementById('mt5VixBtn'); if (vixBtn) vixBtn.onclick = () => sendOverseerCommand('set_product_focus', { focus: 'MT5 VIX' });
    const noteBtn = document.getElementById('assistantNoteBtn'); if (noteBtn) noteBtn.onclick = saveAssistantNote;
    const userSaveBtn = document.getElementById('userMt5SaveBtn'); if (userSaveBtn) userSaveBtn.onclick = () => saveMt5Profile();
    const userConnectBtn = document.getElementById('userMt5ConnectBtn'); if (userConnectBtn) userConnectBtn.onclick = async () => { await saveMt5Profile({ enabled: true }); sendOverseerCommand('set_trade_venue', { enabled: document.getElementById('userMt5VenueInput').value === 'MT5', symbol: document.getElementById('userMt5SymbolInput').value, style: document.getElementById('userMt5StyleInput').value, bridgeUrl: document.getElementById('userMt5BridgeInput').value.trim(), accountLogin: document.getElementById('userMt5LoginInput').value.trim(), accountPassword: document.getElementById('userMt5PasswordInput').value, accountServer: document.getElementById('userMt5ServerInput').value.trim() }); };
    const userArmBtn = document.getElementById('userMt5ArmBtn'); if (userArmBtn) userArmBtn.onclick = async () => { await saveMt5Profile({ enabled: document.getElementById('userMt5VenueInput').value === 'MT5' }); sendOverseerCommand('set_trade_venue', { enabled: document.getElementById('userMt5VenueInput').value === 'MT5', symbol: document.getElementById('userMt5SymbolInput').value, style: document.getElementById('userMt5StyleInput').value, bridgeUrl: document.getElementById('userMt5BridgeInput').value.trim(), accountLogin: document.getElementById('userMt5LoginInput').value.trim(), accountPassword: document.getElementById('userMt5PasswordInput').value, accountServer: document.getElementById('userMt5ServerInput').value.trim() }); };
    const userLiveBtn = document.getElementById('userMt5LiveBtn'); if (userLiveBtn) userLiveBtn.onclick = async () => {
      const venueEnabled = document.getElementById('userMt5VenueInput').value === 'MT5';
      const bridgeUrl = document.getElementById('userMt5BridgeInput').value.trim();
      const current = Boolean(state.mt5Profile && state.mt5Profile.liveTradingEnabled);
      const nextEnabled = !current;
      const saved = await saveMt5Profile({ enabled: venueEnabled, liveTradingEnabled: nextEnabled });
      await sendOverseerCommand('set_trade_venue', { enabled: venueEnabled, symbol: document.getElementById('userMt5SymbolInput').value, style: document.getElementById('userMt5StyleInput').value, bridgeUrl, accountLogin: document.getElementById('userMt5LoginInput').value.trim(), accountPassword: document.getElementById('userMt5PasswordInput').value, accountServer: document.getElementById('userMt5ServerInput').value.trim() });
      await sendOverseerCommand('set_mt5_live', { enabled: nextEnabled, bridgeConnected: !!bridgeUrl });
      state.mt5Profile = { ...(state.mt5Profile || {}), ...(saved || {}), enabled: venueEnabled, liveTradingEnabled: nextEnabled, bridgeUrl };
      hydrateMt5Profile();
      await loadMissionState();
    };
    const userGoldBtn = document.getElementById('userMt5GoldBtn'); if (userGoldBtn) userGoldBtn.onclick = () => sendOverseerCommand('set_product_focus', { focus: 'MT5 Gold' });
    const userVixBtn = document.getElementById('userMt5VixBtn'); if (userVixBtn) userVixBtn.onclick = () => sendOverseerCommand('set_product_focus', { focus: 'MT5 VIX' });
    const copyBtn = document.getElementById('copyTradingBtn'); if (copyBtn) copyBtn.onclick = async () => { await saveMt5Profile(); sendOverseerCommand('set_copy_trading', { followAdmin: document.getElementById('copyFollowInput').value === 'true', mirrorAdminTrades: document.getElementById('copyMirrorInput').value === 'true', riskMultiplier: document.getElementById('copyRiskInput').value, sameAsAdmin: document.getElementById('copySameAsAdminInput').value === 'true' }); };
    loadMissionState(); loadMt5Profile(); clearInterval(state.pollId); state.pollId = setInterval(loadMissionState, 5000);
  }
  document.addEventListener('DOMContentLoaded', bootUi);
  window.StratForgeMissionUI = { loadMissionState, sendOverseerCommand };
})();