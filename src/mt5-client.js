const MT5_API = process.env.STRATFORGE_MT5_API || process.env.MT5_BRIDGE_URL || '';
const MT5_API_KEY = process.env.STRATFORGE_MT5_API_KEY || '';

function ensureConfig() {
  if (!MT5_API) {
    const err = new Error('Missing STRATFORGE_MT5_API');
    err.statusCode = 500;
    throw err;
  }
  if (!MT5_API_KEY) {
    const err = new Error('Missing STRATFORGE_MT5_API_KEY');
    err.statusCode = 500;
    throw err;
  }
}

async function mt5Fetch(path, options = {}) {
  ensureConfig();
  const url = `${MT5_API}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': MT5_API_KEY,
      ...(options.headers || {})
    },
    cache: 'no-store'
  });

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`MT5 API error ${res.status}: ${text}`);
    err.statusCode = res.status;
    throw err;
  }

  return res.json();
}

async function enqueueMt5Command(userId, type, payload = {}) {
  return mt5Fetch(`/users/${encodeURIComponent(userId)}/commands/enqueue`, {
    method: 'POST',
    body: JSON.stringify({ type, payload })
  });
}

async function getMt5Events(userId) {
  return mt5Fetch(`/users/${encodeURIComponent(userId)}/events`);
}

async function saveMt5User(userId, mt5 = {}) {
  return mt5Fetch('/users/save', {
    method: 'POST',
    body: JSON.stringify({
      userId,
      enabled: mt5.enabled !== undefined ? Boolean(mt5.enabled) : true,
      login: String(mt5.login || ''),
      password: String(mt5.password || ''),
      server: String(mt5.server || ''),
      terminalAlias: String(mt5.terminalAlias || `${userId}-mt5`),
      followAdmin: Boolean(mt5.followAdmin),
      riskMultiplier: Number(mt5.riskMultiplier || 1),
      allowedSymbols: Array.isArray(mt5.allowedSymbols) ? mt5.allowedSymbols : [],
      liveTradingArmed: Boolean(mt5.liveTradingArmed)
    })
  });
}

module.exports = {
  mt5Fetch,
  enqueueMt5Command,
  getMt5Events,
  saveMt5User
};
