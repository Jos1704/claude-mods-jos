export type ActivityKind =
  | 'thinking'
  | 'read'
  | 'write'
  | 'edit'
  | 'run'
  | 'search'
  | 'web'
  | 'agent'
  | 'tasks'
  | 'other'

export type Activity = { kind: ActivityKind; detail: string }

export type Task = { id: string; subject: string; activeForm: string; status: 'pending' | 'in_progress' | 'completed' }

export type Counts = { read: number; write: number; edit: number; run: number }

export type Work = {
  isWorking: boolean
  workStartedAt: number
  finishedAt: number
  activity: Activity
  tasks: Task[]
  counts: Counts
  model: string
}

export type Host = {
  sessionId: string
  cwd: string
  pid: number
  tty: string
  termProgram: string
  /** The macOS app the session runs in (`dev.warp.Warp-Stable`, `com.microsoft.VSCode`). */
  bundleId: string
  /** How Claude Code was started: `cli`, `claude-vscode`, `claude-desktop`. */
  entrypoint: string
  home: string
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-buddy': { work: Work; host: Host | null }
  }
}
