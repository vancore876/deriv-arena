# ⚡ StratForge Arena v2.0

A dark, game-inspired multi-user trading bot for Deriv volatility synthetic indices.

## Features

- **3 Trade Modes** — Rise/Fall, Over/Under, Digits Lab
- **3 Style Presets** — Balanced Play, Quick Fire, Calm Mode (per mode)
- **Game UI** — XP, Levels (Rookie → Legend), live candle chart, digit board
- **Multi-user** — JWT auth, admin panel with expiry controls
- **Research-backed strategies** — EMA crossover, Bollinger Band breakout, histogram bias

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Create your .env file
cp .env.example .env
# Edit .env and set a strong JWT_SECRET

# 3. Start the server
npm start
# or for dev with auto-reload:
npm run dev
```

Open `http://localhost:3000` in your browser.

Default login: `admin` / `admin123` (change in .env)

## Deployment (VPS with PM2)

```bash
npm install -g pm2
pm2 start src/server.js --name deriv-arena
pm2 save
pm2 startup
```

## Strategy Presets

### Rise / Fall
| Preset | Strategy | Staking |
|--------|----------|---------|
| Balanced Play | EMA 10/20 crossover | Fixed stake |
| Quick Fire | Bollinger Band breakout | Martingale 2x |
| Calm Mode | 3-tick momentum confirmation | Anti-martingale |

### Over / Under
| Preset | Direction | Entry Filter | Recovery |
|--------|-----------|--------------|----------|
| Balanced Play | Over 4 | 50-tick histogram ≥60% high | Fixed |
| Quick Fire | Over 4 | 50-tick histogram ≥65% high | Martingale 1.8x |
| Calm Mode | Under 5 | 50-tick histogram ≥58% low | PLS 1.3x |

### Digits Lab (Even/Odd)
| Preset | Windows | Thresholds | Recovery |
|--------|---------|------------|----------|
| Balanced Play | 50 + 100 tick | 58% / 55% | Fixed |
| Quick Fire | 50 tick | 60% | Martingale 2x |
| Calm Mode | 100 + 200 tick | 58% / 52% | Anti-martingale |

## ⚠ Risk Warning
Trading carries risk. Never trade with money you cannot afford to lose. Always test on a demo account first. No strategy guarantees profits.
