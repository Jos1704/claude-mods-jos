export type Meter = { percent: number; resetsAt?: string }

export type Usage = {
  context: Meter | null
  fiveHour: Meter | null
  weekly: Meter | null
}

declare module 'claude-code' {
  interface PluginState {
    'usage-meters': { usage: Usage }
  }
}
