import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Entry, Host } from '../types'

// Logs every finished request on this machine, one file per session and day
// under ~/.claude/bitacora/<YYYY-MM-DD>/<session>.jsonl, and reads it back for
// /hoy (the day's log) and /costos (usage by project). Both commands answer
// in the transcript only: the model never reads them, except `/hoy resumen`,
// which asks Haiku for a short summary.

const turn = atom({ plugin: 'bitacora', key: 'turn' } as const, null)
const host = atom({ plugin: 'bitacora', key: 'host' } as const, null)

const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const DAY_MS = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------- formats

const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)

/** The local calendar day of `ms`, as the log's folder names it. */
function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function longDate(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`
}

function shortDate(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]!.slice(0, 3)} ${d.getDate()} ${MONTHS[d.getMonth()]!.slice(0, 3)}`
}

const clock = (ms: number) => `${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))} s`
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${pad(minutes % 60)} min`
}

const usd = (n: number) => `$${n.toFixed(2)}`

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`
  return `${n}`
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** A markdown table cell: no pipes or line breaks. */
const cell = (text: string) => text.replace(/\|/g, '/').replace(/\s+/g, ' ')

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

// ---------------------------------------------------------------- the log

async function describeHost($: EngineInterface): Promise<Host> {
  const { stdout } = await $.process.run(['sh', '-c', 'echo "$HOME"'])
  return { home: stdout.trim(), cwd: await $.session.cwd(), sessionId: await $.session.id() }
}

/** The session's host, described now if session.start has not (a mod installed mid-session). */
async function ensureHost($: EngineInterface): Promise<Host> {
  const known = await read($, host)
  if (known !== null) return known
  const h = await describeHost($)
  await update($, host, () => h)
  return h
}

function logDir(home: string, day: string): string {
  return `${home}/.claude/bitacora/${day}`
}

async function readDay($: EngineInterface, home: string, day: string): Promise<Entry[]> {
  const dir = logDir(home, day)
  if (!(await $.fs.exists(dir))) return []
  const entries: Entry[] = []
  for (const file of await $.fs.list(dir)) {
    if (file.kind !== 'file' || !file.name.endsWith('.jsonl')) continue
    const text = await $.fs.read(`${dir}/${file.name}`).catch(() => '')
    for (const line of String(text).split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as Entry)
      } catch {
        // A line cut by a crash: skip it.
      }
    }
  }
  return entries.sort((a, b) => a.startedAt - b.startedAt)
}

async function readRange($: EngineInterface, home: string, from: number, to: number): Promise<Entry[]> {
  const days: Entry[][] = []
  for (let day = startOfDay(from); day <= to; day = startOfDay(day + DAY_MS + 3_600_000)) {
    days.push(await readDay($, home, dayKey(day)))
  }
  return days.flat()
}

type Totals = { requests: number; ms: number; usd: number; tokens: number; files: Set<string> }

function totals(entries: Entry[]): Totals {
  const files = new Set<string>()
  for (const e of entries) for (const f of e.files) files.add(`${e.project}/${f}`)
  return {
    requests: entries.length,
    ms: entries.reduce((n, e) => n + e.durationMs, 0),
    usd: entries.reduce((n, e) => n + e.usd, 0),
    tokens: entries.reduce((n, e) => n + e.tokensIn + e.tokensOut, 0),
    files,
  }
}

function byProject(entries: Entry[]): [string, Entry[]][] {
  const groups = new Map<string, Entry[]>()
  for (const e of entries) groups.set(e.project, [...(groups.get(e.project) ?? []), e])
  return [...groups].sort((a, b) => totals(b[1]).ms - totals(a[1]).ms)
}

// ---------------------------------------------------------------- /hoy

function parseDay(args: string, now: number): number | null {
  const word = args.trim().toLowerCase()
  if (word === '' || word === 'hoy' || word === 'resumen') return now
  if (word === 'ayer') return now - DAY_MS
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(word)
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12).getTime() : null
}

function dayReport(day: number, entries: Entry[]): string {
  const title = `### 📒 Bitácora · ${longDate(day)}`
  if (entries.length === 0) return `${title}\n\nNo hay peticiones registradas ese día.`

  const sections = byProject(entries).map(([project, list]) => {
    const t = totals(list)
    const rows = list.map(e => {
      const what = cell(clip(e.prompt || '(sin texto)', 70)) + (e.isAborted ? ' _(interrumpida)_' : '')
      return `| ${clock(e.startedAt)} | ${what} | ${duration(e.durationMs)} | ${e.files.length || '·'} |`
    })
    return [
      `**${project}** · ${duration(t.ms)} · ${plural(t.requests, 'petición', 'peticiones')} · ${usd(t.usd)}`,
      '',
      '| Hora | Qué le pediste | Duró | Archivos |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n')
  })
  const t = totals(entries)
  const footer =
    `**Total:** ${duration(t.ms)} con Claude trabajando · ${plural(t.requests, 'petición', 'peticiones')} · ` +
    `${plural(t.files.size, 'archivo cambiado', 'archivos cambiados')} · ${usd(t.usd)} equivalente API`
  return [title, ...sections, footer].join('\n\n')
}

async function summarize($: EngineInterface, day: number, entries: Entry[]): Promise<string> {
  const lines = entries.map(
    e => `- ${clock(e.startedAt)} [${e.project}] ${clip(e.prompt, 200)} (${duration(e.durationMs)}; archivos: ${e.files.slice(0, 8).join(', ') || 'ninguno'})`,
  )
  const reply = await $.model.complete({
    model: 'haiku',
    maxTokens: 700,
    system: 'Eres un asistente que redacta reportes de trabajo breves, en español, para un desarrollador.',
    prompt:
      `Estas son las peticiones que hice a Claude Code el ${longDate(day)}, por hora y proyecto:\n\n${lines.join('\n')}\n\n` +
      'Escribe mi resumen para el daily: por proyecto, de 2 a 4 viñetas con lo que se avanzó, en pasado y primera persona, ' +
      'sin inventar nada que no esté en la lista. Termina con una línea de pendientes solo si se deducen claramente.',
  })
  return reply.isAnswered ? `### ✍️ Resumen para tu daily\n\n${reply.text}` : `_No se pudo generar el resumen (${reply.reason})._`
}

// ---------------------------------------------------------------- /costos

function parseRange(args: string, now: number): { from: number; label: string } | null {
  const word = args.trim().toLowerCase()
  const today = startOfDay(now)
  if (word === 'hoy') return { from: today, label: `hoy, ${longDate(now)}` }
  if (word === '' || word === 'semana') {
    const back = (new Date(now).getDay() + 6) % 7 // days since Monday
    const from = startOfDay(today - back * DAY_MS + 3_600_000)
    return { from, label: `esta semana (${shortDate(from)} – hoy)` }
  }
  if (word === 'mes') {
    const d = new Date(now)
    const from = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    return { from, label: `${MONTHS[d.getMonth()]} ${d.getFullYear()}` }
  }
  const days = /^(\d+)\s*d(?:ías?)?$/.exec(word)
  if (days) {
    const from = startOfDay(now - (Number(days[1]) - 1) * DAY_MS)
    return { from, label: `últimos ${days[1]} días` }
  }
  return null
}

function costReport(label: string, entries: Entry[]): string {
  const title = `### 💸 Consumo por proyecto · ${label}`
  if (entries.length === 0) return `${title}\n\nNo hay peticiones registradas en ese periodo.`

  const all = totals(entries)
  // Share by API-equivalent cost; by time where no cost was recorded.
  const share = (t: Totals) => (all.usd > 0 ? t.usd / all.usd : all.ms > 0 ? t.ms / all.ms : 0)
  const groups = byProject(entries)
    .map(([project, list]) => ({ project, t: totals(list) }))
    .sort((a, b) => share(b.t) - share(a.t))
  const nameWidth = Math.min(22, Math.max(...groups.map(g => g.project.length)))
  const rows = groups.map(({ project, t }) => {
    const part = share(t)
    const filled = Math.round(part * 16)
    return [
      clip(project, nameWidth).padEnd(nameWidth),
      '█'.repeat(filled) + '░'.repeat(16 - filled),
      `${Math.round(part * 100)}%`.padStart(4),
      usd(t.usd).padStart(9),
      `${tokens(t.tokens)} tokens`.padStart(13),
      plural(t.requests, 'petición', 'peticiones').padStart(14),
      duration(t.ms).padStart(12),
    ].join('  ')
  })
  return [
    title,
    ['```', ...rows, '```'].join('\n'),
    `**Total:** ${usd(all.usd)} equivalente API · ${tokens(all.tokens)} tokens · ` +
      `${plural(all.requests, 'petición', 'peticiones')} · ${duration(all.ms)} con Claude trabajando`,
    '> Con suscripción no pagas estos montos: son el precio que tendría en la API y sirven para ver qué proyecto se lleva tu límite. Cuentan solo lo de este equipo.',
  ].join('\n\n')
}

// ---------------------------------------------------------------- hooks

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await update($, host, () => null)
    await ensureHost($)
    await $.command.register({
      name: 'hoy',
      description: 'Bitácora del día: qué le pediste a Claude, por proyecto (`ayer`, `AAAA-MM-DD`, `resumen`)',
      argumentHint: '[ayer | AAAA-MM-DD | resumen]',
    })
    await $.command.register({
      name: 'costos',
      description: 'Consumo por proyecto (`hoy`, `semana`, `mes`, `30d`)',
      argumentHint: '[hoy | semana | mes | 30d]',
    })
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const usage = await $.session.usage()
      const prompt = e.text.split('\n').map(line => line.trim()).find(Boolean) ?? ''
      const startedAt = await $.clock.now()
      await update($, turn, () => ({ prompt: clip(prompt, 160), startedAt, usdAtStart: usage.cost?.usd ?? 0, files: [] }))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    if (!EDIT_TOOLS.includes(e.tool) || result.deny !== undefined || result.isError) return result
    const args = e as unknown as Record<string, unknown>
    const path = String(args.file_path ?? args.notebook_path ?? '')
    const root = (await ensureHost($)).cwd
    const name = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
    await update($, turn, t => (t === null || t.files.includes(name) ? t : { ...t, files: [...t.files, name] }))
    return result
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const t = await read($, turn)
    if (e.agentId === undefined && t !== null) {
      const h = await ensureHost($)
      await update($, turn, () => null)
      const usage = await $.session.usage()
      const u = e.usage
      const entry: Entry = {
        sessionId: h.sessionId,
        project: h.cwd.split('/').filter(Boolean).pop() ?? h.cwd,
        cwd: h.cwd,
        prompt: t.prompt,
        startedAt: t.startedAt,
        durationMs: e.durationMs,
        files: t.files,
        tokensIn: u ? u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens : 0,
        tokensOut: u?.output_tokens ?? 0,
        usd: Math.max(0, (usage.cost?.usd ?? 0) - t.usdAtStart),
        model: u?.model ?? (await $.session.model()),
        isAborted: e.isAborted,
      }
      const file = `${logDir(h.home, dayKey(t.startedAt))}/${h.sessionId}.jsonl`
      const before = (await $.fs.exists(file)) ? String(await $.fs.read(file)) : ''
      await $.fs.write(file, `${before}${JSON.stringify(entry)}\n`)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'hoy' }, async ($, e) => {
    const h = await ensureHost($)
    const now = await $.clock.now()
    const day = parseDay(e.args, now)
    if (day === null) return { text: 'Uso: `/hoy`, `/hoy ayer`, `/hoy 2026-10-23` o `/hoy resumen`.' }
    const entries = await readDay($, h.home, dayKey(day))
    const report = dayReport(day, entries)
    if (e.args.trim().toLowerCase() !== 'resumen' || entries.length === 0) return { text: report }
    return { text: `${report}\n\n${await summarize($, day, entries)}` }
  })

  on('command.run', { command: 'costos' }, async ($, e) => {
    const h = await ensureHost($)
    const now = await $.clock.now()
    const range = parseRange(e.args, now)
    if (range === null) return { text: 'Uso: `/costos`, `/costos hoy`, `/costos semana`, `/costos mes` o `/costos 30d`.' }
    return { text: costReport(range.label, await readRange($, h.home, range.from, now)) }
  })
}
