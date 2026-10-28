/** One edit as Claude made it: the text it replaced and the text it wrote. */
export type Hunk = { before: string; after: string }

export type ChangedFile = {
  path: string
  isNew: boolean
  added: number
  removed: number
  hunks: Hunk[]
  changedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    cambios: { files: ChangedFile[]; selected: string | null; cwd: string }
  }
}
