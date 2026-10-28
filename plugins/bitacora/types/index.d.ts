/** One finished request to Claude, as the log keeps it. */
export type Entry = {
  sessionId: string
  project: string
  cwd: string
  prompt: string
  startedAt: number
  durationMs: number
  /** Files Claude created or edited during it, relative to the project. */
  files: string[]
  tokensIn: number
  tokensOut: number
  /** What it would cost at API prices: a measure of usage, not a bill. */
  usd: number
  model: string
  isAborted: boolean
}

/** The request under way: what the log needs from its start. */
export type Turn = { prompt: string; startedAt: number; usdAtStart: number; files: string[] }

export type Host = { home: string; cwd: string; sessionId: string }

declare module 'claude-code' {
  interface PluginState {
    bitacora: { turn: Turn | null; host: Host | null }
  }
}
