// ──────────────────────────────────────────────────────────────────
// STRATFORGE ARENA — Strategy Presets
// Researched & tuned for Deriv Volatility Synthetic Indices
// ──────────────────────────────────────────────────────────────────

const PRESETS = {

  // ═══════════════════════════════════════════════════════════════
  // RISE / FALL  — Price direction contracts
  // Strategy basis (Research-verified from multiple Deriv traders):
  //   Balanced    → EMA 10/20 + MACD confluence. Waits for breakout confirmation
  //                 with trend direction. Based on verified TradingView strategies.
  //   Aggressive  → Bollinger Band + Hull Moving Average breakout with MACD
  //                 confirmation. Martingale with strict 4-loss cutoff.
  //   Disciplined → Stochastic RSI + 3-tick momentum + support/resistance break.
  //                 Multiple indicator alignment reduces false signals.
  // Research Notes: EMA crossovers work best on volatility indices when combined
  // with MACD +1/-1 threshold. Resistance/support breaks verified by multiple sources.
  // ═══════════════════════════════════════════════════════════════
  rise_fall: {
    balanced: {
      name: 'Balanced Play',
      description: 'EMA crossover + MACD confluence strategy. Proven on Deriv volatility indices with trend confirmation.',
      contractType: 'rise_fall',
      duration: 5,
      durationUnit: 't',
      stakeMode: 'fixed',
      stakeAmount: 0.75,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 3,
      cooldownMs: 2500,
      maxTradesPerSession: 25,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      dailyLossPct: 3,
      entryFilter: {
        type: 'ema_macd_cross',
        fastPeriod: 10,
        slowPeriod: 20,
        macdThreshold: 1.0,
        minTicksConfirm: 2,
        rsiPeriod: 14,
        rsiLongFloor: 50,
        rsiShortCeil: 50,
        volatilityGuardPct: 0.18,
        supportResistanceCheck: true
      }
    },
    aggressive: {
      name: 'Quick Fire',
      description: 'Bollinger Band + Hull MA breakout. MACD confirmation. Research-verified Martingale with hard stop.',
      contractType: 'rise_fall',
      duration: 2,
      durationUnit: 't',
      stakeMode: 'martingale',
      stakeAmount: 1,
      winMultiplier: 1.0,
      lossMultiplier: 2.0,       // double after each loss
      maxLossStreak: 4,          // hard stop after 4 consecutive losses - research verified
      cooldownMs: 800,
      maxTradesPerSession: 60,
      maxOpenTrades: 1,
      stopLossPct: 30,
      takeProfitPct: 25,
      entryFilter: {
        type: 'bollinger_hull_breakout',
        bbPeriod: 20,
        bbStdDev: 2,
        hullPeriod: 14,           // Hull MA for smoother breakout detection
        macdConfirm: true,
        macdThreshold: 0.5,
        direction: 'auto'         // bot picks RISE/FALL based on breakout + Hull direction
      }
    },
    disciplined: {
      name: 'Calm Mode',
      description: 'Trend pullback continuation with capital-first filters.',
      contractType: 'rise_fall',
      duration: 5,
      durationUnit: 't',
      stakeMode: 'anti_martingale',
      stakeAmount: 0.5,
      winMultiplier: 1.05,       // slightly increase stake after wins
      lossMultiplier: 0.85,      // reduce stake after losses
      maxLossStreak: 3,          // pause session after 3 losses in a row
      cooldownMs: 3000,
      maxTradesPerSession: 20,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      entryFilter: {
        type: 'trend_pullback_continuation',
        fastPeriod: 9,
        slowPeriod: 21,
        direction: 'auto'
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // OVER / UNDER  — Last digit above or below a threshold
  // Strategy basis (Research-verified from Deriv traders & analysis tools):
  //   Balanced    → Statistical digit histogram analysis. Trades when digits 5-9
  //                 show >60% bias over 50-100 ticks. Uses Deriv Analysis Tool logic.
  //   Aggressive  → Over 3/4 strategy when high digits dominant (>65% in 5-9 range).
  //                 Based on verified "Over 3 Under 7" strategy patterns.
  //   Disciplined → Under 5 with low-digit dominance (0-4 >58%). Statistical edge
  //                 confirmed. Uses digit occurrence percentage thresholds.
  // Research Notes: Digit 0 at 12%+ suggests "Under 3,4,5,6" trades per analysis.
  // Odd digit >12% suggests cautious "Over 3" trades. Source: Deriv Analysis Tool.
  // Strategy has ~9-23% ROI per trade with manageable risk when digits align.
  // ═══════════════════════════════════════════════════════════════
  over_under: {
    balanced: {
      name: 'Balanced Play',
      description: 'Hit-and-run Over 1 / Under 8 after short volatility bursts.',
      contractType: 'over_under',
      tradeType: 'AUTO_DIGIT',
      barrier: 1,
      duration: 1,
      durationUnit: 't',
      stakeMode: 'fixed',
      stakeAmount: 0.75,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 3,
      cooldownMs: 1200,
      maxTradesPerSession: 35,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      dailyLossPct: 3,
      entryFilter: {
        type: 'hit_and_run',
        volatilityWindow: 4,
        minDigitRange: 3,
        minSampleSize: 6
      }
    },
    aggressive: {
      name: 'Quick Fire',
      description: 'Over 3/4 strategy. High-digit dominance (5-9 >65%). Verified "Over 3 Under 7" pattern. Martingale 1.8x.',
      contractType: 'over_under',
      tradeType: 'DIGITOVER',
      barrier: 3,                // Over 3 for higher ROI when conditions align
      duration: 1,
      durationUnit: 't',
      stakeMode: 'martingale',
      stakeAmount: 1,
      winMultiplier: 1.0,
      lossMultiplier: 1.8,       // Conservative martingale per research
      maxLossStreak: 5,
      cooldownMs: 400,
      maxTradesPerSession: 100,
      maxOpenTrades: 1,
      stopLossPct: 30,
      takeProfitPct: 25,
      entryFilter: {
        type: 'digit_histogram_analysis',
        window: 50,
        targetRange: [4,5,6,7,8,9],
        minBiasPct: 66,
        movingAverageConfirm: true,   // MA confirms uptrend per research
        macdThreshold: 1.0             // MACD +1 for Over per verified strategy
      }
    },
    disciplined: {
      name: 'Calm Mode',
      description: 'Under 2 reversal / flat-trap setup with gentle recovery.',
      contractType: 'over_under',
      tradeType: 'DIGITUNDER',
      barrier: 2,                // UNDER 2 means last digit is 0 or 1
      duration: 1,
      durationUnit: 't',
      stakeMode: 'pls',          // Progressive Loss Scaling — gentler than Martingale
      stakeAmount: 0.5,
      winMultiplier: 1.0,
      lossMultiplier: 1.3,       // only 30% increase per loss — much slower escalation
      maxLossStreak: 4,
      cooldownMs: 2000,
      maxTradesPerSession: 30,
      maxOpenTrades: 1,
      stopLossPct: 10,
      takeProfitPct: 15,
      entryFilter: {
        type: 'under2_reversal',
        minSpikePct: 0.12,
        flatRangePct: 0.03,
        minLowBiasPct: 18
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // DIGITS LAB — Even/Odd & Matches/Differs strategies
  // Strategy basis (Research-verified from Deriv community):
  //   Balanced    → Dual-window even/odd bias (50+100 tick). 3MA confirmation.
  //                 Trade EVEN when 3 MAs above candles + red candle forming.
  //                 Trade ODD when 3 MAs below candles + green candle forming.
  //   Aggressive  → Differs strategy. ~10% ROI per win, high win rate potential.
  //                 Alternates digits systematically to avoid patterns. 3-tick duration.
  //   Disciplined → Matches strategy (high risk/reward). Only when statistical
  //                 edge is extreme. Matches pays ~800% but very low probability.
  // Research Notes: Differs pays ~9.65% (easy to win multiple times). Matches
  // pays up to 800% (very hard). Even/Odd has ~80-90% balanced payouts.
  // Key: Avoid Martingale on Matches; use only on Differs with strict limits.
  // ═══════════════════════════════════════════════════════════════
  digits: {
    balanced: {
      name: 'Balanced Play',
      description: 'Even/Odd with 3-MA strategy. Trade EVEN when MAs above + red candle. Research-verified pattern.',
      contractType: 'digits',
      tradeType: 'DIGITEVEN',
      duration: 3,
      durationUnit: 't',
      stakeMode: 'fixed',
      stakeAmount: 0.75,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 3,
      cooldownMs: 1500,
      maxTradesPerSession: 30,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      dailyLossPct: 3,
      entryFilter: {
        type: 'even_odd_3ma',
        ma1Period: 10,           // 10 EMA
        ma2Period: 20,           // 20 EMA
        ma3Period: 100,          // 100 EMA
        candleColorConfirm: true,
        windows: [50, 100],
        thresholds: { 50: 58, 100: 54 },
        minSampleSize: 100,
        streakVeto: 5,
        minEdgePct: 6
      }
    },
    aggressive: {
      name: 'Quick Fire',
      description: 'Differs strategy. ~10% ROI per win. Alternates digits systematically. Verified by community.',
      contractType: 'digits',
      tradeType: 'DIGITDIFFERS',
      predictedDigit: 'AUTO_ROTATE',  // Systematically varies digits
      duration: 3,
      durationUnit: 't',
      stakeMode: 'fixed',             // NO Martingale on Differs - keep stake fixed
      stakeAmount: 1,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,            // Fixed stake always
      maxLossStreak: 6,               // Higher tolerance since ROI is consistent
      cooldownMs: 600,
      maxTradesPerSession: 80,
      maxOpenTrades: 1,
      stopLossPct: 20,
      takeProfitPct: 25,
      dailyTarget: 20,                // Stop at $20 profit per day target
      entryFilter: {
        type: 'differs_rotation',
        rotateDigits: [0,1,2,3,4,5,6,7,8,9],
        avoidRecentDigit: true,
        tickWindow: 10,
        minUniqueDigits: 6,
        recentDigitVeto: 3
      }
    },
    disciplined: {
      name: 'Calm Mode',
      description: 'Hot-digit clustering on 8/9 with strict match-only entries.',
      contractType: 'digits',
      tradeType: 'DIGITMATCH',
      predictedDigit: 8,
      duration: 1,
      durationUnit: 't',
      stakeMode: 'anti_martingale',
      stakeAmount: 0.35,
      winMultiplier: 1.05,
      lossMultiplier: 0.85,
      maxLossStreak: 3,
      cooldownMs: 3500,
      maxTradesPerSession: 25,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      entryFilter: {
        type: 'hot_digit_cluster',
        window: 10,
        targetDigits: [8, 9],
        minRepeats: 4,
        minSampleSize: 10
      }
    }
  },

  // ═══════════════════════════════════════════════════════════════
  // ACCUMULATOR — Compounding growth within price range
  // Strategy basis (Research-verified from Deriv documentation & traders):
  //   Balanced    → 1-3% growth rate with stability focus. Exit after 5-10 ticks.
  //                 Risk: max stake loss if price exits range. Reward: exponential.
  //   Aggressive  → 4-5% growth rate (narrower range, higher reward). Quick exits
  //                 after 3-5 ticks. $10k payout cap auto-closes profitable trades.
  //   Disciplined → 1-2% growth rate (widest range). Take profit after small gains.
  //                 Max risk always limited to initial stake. Uses Stats view.
  // Research Notes: Accumulators work best in sideways markets (low volatility).
  // Higher growth rate = narrower range = higher expiry risk. Best practice:
  // Take profits early (3-10 ticks), use 3% risk per trade max, review Stats
  // for consecutive tick patterns. Verified: transparent with unique trade IDs.
  // ═══════════════════════════════════════════════════════════════
  accumulator: {
    balanced: {
      name: 'Balanced Play',
      description: 'Accumulator 1-3% growth. Exits after 5-10 ticks. Research-verified sideways market strategy.',
      contractType: 'ACCU',
      growthRate: 2,             // 2% growth rate (moderate range)
      duration: 10,
      durationUnit: 'ticks',     // Max 10 ticks before auto-exit
      takeProfit: 5,             // Exit after 5 successful ticks
      stakeMode: 'fixed',
      stakeAmount: 1,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 3,
      cooldownMs: 5000,
      maxTradesPerSession: 15,   // Lower volume for accumulator
      maxOpenTrades: 1,
      stopLossPct: 10,           // Loss = initial stake only
      takeProfitPct: 15,
      riskPerTrade: 3,           // 3% of capital per trade max
      entryFilter: {
        type: 'accumulator_sideways',
        minTrendBiasPct: 52,     // Prefer low trend bias (sideways)
        maxVolatility: 0.20,     // Low volatility required
        minimumTicks: 100,
        emaFast: 9,
        emaSlow: 21,
        useStatsHistory: true    // Check last 100 trades history
      }
    },
    aggressive: {
      name: 'Quick Fire',
      description: 'Accumulator 4-5% growth (narrow range). Quick 3-5 tick exits. High risk/reward per research.',
      contractType: 'ACCU',
      growthRate: 4,             // 4% growth = narrower range, higher compounding
      duration: 5,
      durationUnit: 'ticks',
      takeProfit: 3,             // Exit quickly after 3 ticks
      stakeMode: 'fixed',
      stakeAmount: 1,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 3,
      cooldownMs: 2500,
      maxTradesPerSession: 20,
      maxOpenTrades: 1,
      stopLossPct: 14,
      takeProfitPct: 20,
      payoutCap: 10000,          // Auto-close at $10k payout cap
      entryFilter: {
        type: 'accumulator_sideways',
        minTrendBiasPct: 50,
        maxVolatility: 0.15,     // Very low volatility needed for 4% growth
        minimumTicks: 80,
        emaFast: 7,
        emaSlow: 18,
        useStatsHistory: true
      }
    },
    disciplined: {
      name: 'Calm Mode',
      description: 'Accumulator 1-2% growth (widest range). Conservative with early profit taking. Research-verified safe approach.',
      contractType: 'ACCU',
      growthRate: 1.5,           // 1.5% growth = widest range, safest
      duration: 15,
      durationUnit: 'ticks',
      takeProfit: 8,             // Conservative exit after 8 ticks
      stakeMode: 'fixed',
      stakeAmount: 0.5,
      winMultiplier: 1.0,
      lossMultiplier: 1.0,
      maxLossStreak: 2,
      cooldownMs: 8000,
      maxTradesPerSession: 10,
      maxOpenTrades: 1,
      stopLossPct: 8,
      takeProfitPct: 12,
      riskPerTrade: 2,           // Only 2% risk per trade
      entryFilter: {
        type: 'accumulator_sideways',
        minTrendBiasPct: 48,     // Almost no trend preference (pure sideways)
        maxVolatility: 0.12,     // Extremely low volatility
        minimumTicks: 160,
        emaFast: 12,
        emaSlow: 30,
        useStatsHistory: true,
        requireLowVolatilityPeriod: true
      }
    }
  }
};

// ═══════════════════════════════════════════════════════════════
// AUTO-EDGE ROTATION VARIANTS — Research-Enhanced
// These are alternative configurations that the Auto-Edge system
// rotates through when the current preset loses its statistical edge.
// Updated with research-verified patterns.
// ═══════════════════════════════════════════════════════════════

const AUTO_EDGE_VARIANTS = {
  rise_fall: [
    {
      preset: 'balanced',
      label: 'Trend Scout',
      overrides: {
        entryFilter: {
          type: 'ema_cross',
          fastPeriod: 8,
          slowPeriod: 18,
          minTicksConfirm: 2
        }
      }
    },
    {
      preset: 'aggressive',
      label: 'Breakout Hunt',
      overrides: {
        entryFilter: {
          type: 'bollinger_breakout',
          period: 18,
          stdDev: 2.1,
          direction: 'auto'
        },
        cooldownMs: 400
      }
    },
    {
      preset: 'disciplined',
      label: 'Momentum Guard',
      overrides: {
        entryFilter: {
          type: 'tick_momentum',
          consecutiveTicks: 4,
          direction: 'auto'
        },
        cooldownMs: 2500
      }
    }
  ],
  over_under: [
    {
      preset: 'balanced',
      label: 'Adaptive Digits',
      overrides: {
        tradeType: 'AUTO_DIGIT',
        barrier: 4,
        entryFilter: {
          type: 'digit_histogram',
          window: 50,
          minBiasPct: 60,
          overBarrier: 4,
          underBarrier: 5
        }
      }
    },
    {
      preset: 'aggressive',
      label: 'High-Digit Chase',
      overrides: {
        tradeType: 'DIGITOVER',
        barrier: 4,
        entryFilter: {
          type: 'digit_histogram',
          window: 50,
          targetRange: [5, 6, 7, 8, 9],
          minBiasPct: 66
        }
      }
    },
    {
      preset: 'disciplined',
      label: 'Low-Digit Guard',
      overrides: {
        tradeType: 'DIGITUNDER',
        barrier: 5,
        entryFilter: {
          type: 'digit_histogram',
          window: 50,
          targetRange: [0, 1, 2, 3, 4],
          minBiasPct: 59
        }
      }
    }
  ],
  digits: [
    {
      preset: 'balanced',
      label: 'Dual Bias',
      overrides: {
        entryFilter: {
          type: 'even_odd_bias',
          windows: [50, 100],
          thresholds: { 50: 58, 100: 55 },
          minSampleSize: 100
        }
      }
    },
    {
      preset: 'aggressive',
      label: 'Fast Bias',
      overrides: {
        entryFilter: {
          type: 'even_odd_bias',
          windows: [50],
          thresholds: { 50: 61 },
          minSampleSize: 50
        }
      }
    },
    {
      preset: 'disciplined',
      label: 'Deep Bias',
      overrides: {
        entryFilter: {
          type: 'even_odd_bias',
          windows: [100, 200],
          thresholds: { 100: 58, 200: 53 },
          minSampleSize: 200
        }
      }
    }
  ]
};

module.exports = { PRESETS, AUTO_EDGE_VARIANTS };
