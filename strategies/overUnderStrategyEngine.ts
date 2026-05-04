/**
 * Type definitions mirroring the server-side confluence engine.
 * Live evaluation runs in Python: `modules/over_under_strategy_engine.py`
 * (connected to Deriv tick history — not executed in the browser).
 */
export type ConfluenceSignal = "OVER" | "UNDER" | "NONE";
export type MarketMode = "TREND" | "RANGE" | "CHOP";

export interface ConfluenceResult {
  signal: ConfluenceSignal;
  confidence: number;
  reasons: string[];
  marketMode: MarketMode;
  entryAllowed: boolean;
  overScore?: number;
  underScore?: number;
  confirmations?: number;
  confluenceEnabled?: boolean;
  baseSide?: "OVER" | "UNDER";
}

export interface ConfluenceConfig {
  enabled: boolean;
  minScore: number;
  minConfirmations: number;
  useTrend: boolean;
  useSr: boolean;
  useRsi: boolean;
  useCandles: boolean;
  useRange: boolean;
  ticksPerCandle?: number;
  srLookback?: number;
  srTolerancePct?: number;
  historyTicks?: number;
}
