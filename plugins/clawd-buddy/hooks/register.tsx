import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityKind, Counts, Host, Mood, Task, Work } from '../types'

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
  waiting: '',
  waitingSince: 0,
  mood: { kind: '', at: 0, detail: '' },
  contextPercent: 0,
}

const TEST_COMMAND =
  /\b(?:artisan\s+test|phpunit|pest|vendor\/bin\/(?:phpunit|pest)|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/

// Tools that stop for the person by their nature, and what Clawd says meanwhile.
const ASKS_THE_PERSON: Record<string, string> = {
  AskUserQuestion: 'Tiene una pregunta para ti',
  ExitPlanMode: 'Quiere que apruebes el plan',
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

/** What a finished tool call says about Clawd's mood, if anything. */
function moodAfter(tool: string, args: Record<string, unknown>, isError: boolean, now: number): Mood | null {
  const isTest = tool === 'Bash' && TEST_COMMAND.test(String(args.command ?? ''))
  if (isTest) return { kind: isError ? 'worried' : 'happy', at: now, detail: isError ? 'Fallaron los tests' : '¡Tests en verde!' }
  if (isError) return { kind: 'worried', at: now, detail: `Falló ${tool}` }
  return null
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

// On Linux the app is the `clawd-float` binary `cargo install` put on the PATH
// (or in ~/.cargo/bin); started once, detached from this session.
const START_ON_LINUX =
  'pgrep -x clawd-float >/dev/null && exit 0; ' +
  'bin=$(command -v clawd-float || echo "$HOME/.cargo/bin/clawd-float"); ' +
  '[ -x "$bin" ] && (setsid "$bin" >/dev/null 2>&1 &)'

async function showApp($: EngineInterface) {
  const system = await $.process.run(['uname']).catch(() => null)
  const argv = system?.stdout.trim() === 'Darwin' ? ['open', '-g', '-a', APP] : ['sh', '-c', START_ON_LINUX]
  await $.process.run(argv).catch(() => undefined)
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
      contextPercent: w.contextPercent ?? 0,
      model,
    }))
    await publish($)
    return next(e)
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined && e.approver === 'person') {
      const now = await $.clock.now()
      await update($, work, w => ({ ...w, waiting: `Necesita tu permiso: ${e.tool}`, waitingSince: now }))
      await publish($)
    }
    return verdict
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's call may still have stopped for a permission: clear it once answered.
      const result = await next(e)
      if ((await read($, work)).waiting !== '') {
        await update($, work, w => ({ ...w, waiting: '' }))
        await publish($)
      }
      return result
    }
    const tool: string = e.tool
    const args = e as unknown as Record<string, unknown>
    const activity = activityFor(tool, args)
    const asks = ASKS_THE_PERSON[tool]
    const startedAt = await $.clock.now()
    await update($, work, w => ({
      ...w,
      activity,
      counts: bump(w.counts, activity.kind),
      ...(asks ? { waiting: asks, waitingSince: startedAt } : {}),
    }))
    await publish($)

    const result = await next(e)
    const mood = moodAfter(tool, args, result.isError === true, await $.clock.now())

    const newId = tool === 'TaskCreate' ? (/#(\d+)/.exec(JSON.stringify(result))?.[1] ?? null) : null
    // Once a tool is done the model is thinking again, until the next one.
    await update($, work, w => ({
      ...w,
      activity: w.activity.kind === activity.kind && w.activity.detail === activity.detail ? THINKING : w.activity,
      tasks: activity.kind === 'tasks' ? applyTasks(w.tasks, tool, args, newId) : w.tasks,
      // Answered: the permission or the question is behind us.
      waiting: '',
      mood: mood ?? w.mood,
    }))
    await publish($)
    return result
  })
    // Clawd must never stand in a tool's way.
    .catch(($, e, next) => next(e))

  on('session.measure', async ($, e, next) => {
    const percent = Math.round(e.context.percent ?? 0)
    if (percent !== (await read($, work)).contextPercent) {
      await update($, work, w => ({ ...w, contextPercent: percent }))
      await publish($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, work, w => ({ ...w, isWorking: false, finishedAt: now, activity: THINKING, waiting: '' }))
      await publish($)
    }
    return next(e)
  })
}
