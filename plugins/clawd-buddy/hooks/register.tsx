import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityKind, Counts, Host, Task, Work } from '../types'

// The floating Clawd app (~/mods/clawd-float) draws this session from the
// file this mod keeps at ~/.claude/clawd/sessions/<session id>.json.

const THINKING: Activity = { kind: 'thinking', detail: '' }

const IDLE: Work = {
  isWorking: false,
  workStartedAt: 0,
  finishedAt: 0,
  activity: THINKING,
  tasks: [],
  counts: { read: 0, write: 0, edit: 0, run: 0 },
  model: '',
}

const work = atom({ plugin: 'clawd-buddy', key: 'work' } as const, IDLE)
const host = atom({ plugin: 'clawd-buddy', key: 'host' } as const, null)

const APP = 'Clawd'
// The pane earlier versions opened; closed if a session still has it.
const OLD_PANE = 'clawd'

function basename(path: unknown): string {
  return typeof path === 'string' ? path.split('/').filter(Boolean).pop() ?? path : ''
}

function clip(text: unknown, max: number): string {
  const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** `S=/tmp/x; FOO=1 cargo build` -> `cargo build` */
function withoutEnv(command: unknown): string {
  if (typeof command !== 'string') return ''
  return command
    .split(/\s*(?:;|&&)\s*/)
    .map(part => part.replace(/^(?:\w+=\S*\s*)+/, '').trim())
    .filter(Boolean)
    .join(' && ')
}

function activityFor(tool: string, args: Record<string, unknown>): Activity {
  switch (tool) {
    case 'Read':
      return { kind: 'read', detail: basename(args.file_path) }
    case 'Write':
      return { kind: 'write', detail: basename(args.file_path) }
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', detail: basename(args.file_path) }
    case 'NotebookEdit':
      return { kind: 'edit', detail: basename(args.notebook_path) }
    case 'Bash':
      return { kind: 'run', detail: clip(args.description ?? withoutEnv(args.command), 60) }
    case 'Grep':
    case 'Glob':
    case 'ToolSearch':
      return { kind: 'search', detail: clip(args.pattern ?? args.query, 60) }
    case 'WebFetch':
      return { kind: 'web', detail: clip(args.url, 60) }
    case 'WebSearch':
      return { kind: 'web', detail: clip(args.query, 60) }
    case 'Agent':
      return { kind: 'agent', detail: clip(args.description, 60) }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return { kind: 'tasks', detail: '' }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      return { kind: 'other', detail: mcp ? `${mcp[1]} › ${mcp[2]}` : tool }
    }
  }
}

function bump(counts: Counts, kind: ActivityKind): Counts {
  return kind === 'read' || kind === 'write' || kind === 'edit' || kind === 'run'
    ? { ...counts, [kind]: counts[kind] + 1 }
    : counts
}

function applyTasks(tasks: Task[], tool: string, args: Record<string, unknown>, newId: string | null): Task[] {
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    return (args.todos as { content: string; activeForm: string; status: Task['status'] }[]).map((t, i) => ({
      id: String(i + 1),
      subject: t.content,
      activeForm: t.activeForm,
      status: t.status,
    }))
  }
  if (tool === 'TaskCreate') {
    const subject = String(args.subject ?? '')
    return [
      ...tasks,
      {
        id: newId ?? String(tasks.length + 1),
        subject,
        activeForm: String(args.activeForm ?? subject),
        status: 'pending',
      },
    ]
  }
  if (tool === 'TaskUpdate') {
    if (args.status === 'deleted') return tasks.filter(t => t.id !== args.taskId)
    return tasks.map(t =>
      t.id !== args.taskId
        ? t
        : {
            ...t,
            subject: typeof args.subject === 'string' ? args.subject : t.subject,
            activeForm: typeof args.activeForm === 'string' ? args.activeForm : t.activeForm,
            status: args.status === 'pending' || args.status === 'in_progress' || args.status === 'completed' ? args.status : t.status,
          },
    )
  }
  return tasks
}

/** Writes this session's state where the app reads it. */
async function publish($: EngineInterface, isEnded = false) {
  const h = await read($, host)
  if (h === null) return
  const w = await read($, work)
  const snapshot = {
    sessionId: h.sessionId,
    pid: h.pid,
    tty: h.tty,
    termProgram: h.termProgram,
    bundleId: h.bundleId,
    entrypoint: h.entrypoint,
    cwd: h.cwd,
    ended: isEnded,
    updatedAt: await $.clock.now(),
    ...w,
  }
  await $.fs.write(`${h.home}/.claude/clawd/sessions/${h.sessionId}.json`, JSON.stringify(snapshot))
}

/** Which process, terminal and tab this session runs in, so a click can bring it forward. */
async function describeHost($: EngineInterface): Promise<Host> {
  const { stdout } = await $.process.run([
    'sh',
    '-c',
    'echo "$PPID"; ps -o tty= -p "$PPID"; echo "$TERM_PROGRAM"; echo "$__CFBundleIdentifier"; echo "$CLAUDE_CODE_ENTRYPOINT"; echo "$HOME"',
  ])
  const [pid = '0', tty = '', termProgram = '', bundleId = '', entrypoint = '', home = ''] = stdout
    .split('\n')
    .map(line => line.trim())
  return {
    sessionId: await $.session.id(),
    cwd: await $.session.cwd(),
    pid: Number(pid) || 0,
    tty,
    termProgram,
    bundleId,
    entrypoint,
    home,
  }
}

async function showApp($: EngineInterface) {
  await $.process.run(['open', '-g', '-a', APP]).catch(() => undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'clawd',
      description: 'Muestra a Clawd flotando en tu escritorio',
    })
    if ((await $.ui.panes()).some(p => p.id === OLD_PANE)) await $.ui.close({ id: OLD_PANE })

    const h = await describeHost($)
    await update($, host, () => h)
    await publish($)
    await showApp($)
    return result
  })

  on('command.run', { command: 'clawd' }, async $ => {
    const h = await read($, host)
    if (h !== null) {
      await $.fs.write(`${h.home}/.claude/clawd/control.json`, JSON.stringify({ showAt: await $.clock.now() }))
    }
    await showApp($)
    return { text: 'Clawd está en tu escritorio. Arrástralo a donde quieras; un clic te trae a esta sesión.' }
  })

  on('session.end', async ($, e, next) => {
    await publish($, true).catch(() => undefined)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const model = await $.session.model()
    const now = await $.clock.now()
    await update($, work, w => ({
      ...IDLE,
      isWorking: true,
      workStartedAt: now,
      tasks: w.tasks.some(t => t.status !== 'completed') ? w.tasks : [],
      model,
    }))
    await publish($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool: string = e.tool
    const args = e as unknown as Record<string, unknown>
    const activity = activityFor(tool, args)
    await update($, work, w => ({ ...w, activity, counts: bump(w.counts, activity.kind) }))
    await publish($)

    const result = await next(e)

    const newId = tool === 'TaskCreate' ? (/#(\d+)/.exec(JSON.stringify(result))?.[1] ?? null) : null
    // Once a tool is done the model is thinking again, until the next one.
    await update($, work, w => ({
      ...w,
      activity: w.activity.kind === activity.kind && w.activity.detail === activity.detail ? THINKING : w.activity,
      tasks: activity.kind === 'tasks' ? applyTasks(w.tasks, tool, args, newId) : w.tasks,
    }))
    await publish($)
    return result
  })
    // Clawd must never stand in a tool's way.
    .catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, work, w => ({ ...w, isWorking: false, finishedAt: now, activity: THINKING }))
      await publish($)
    }
    return next(e)
  })
}
