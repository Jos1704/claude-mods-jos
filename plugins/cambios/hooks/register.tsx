import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ChangedFile, Hunk } from '../types'

// A pane with every file Claude created or edited this session, its lines
// added and removed, and the diff of the one picked. It only watches the edit
// tools and draws: nothing reaches the model.

const files = atom({ plugin: 'cambios', key: 'files' } as const, [])
const selected = atom({ plugin: 'cambios', key: 'selected' } as const, null)
const cwd = atom({ plugin: 'cambios', key: 'cwd' } as const, '')

const PANE = { id: 'cambios', title: 'Cambios', columns: 64 } as const
const EDIT_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit']
// What a file keeps, so a long session stays light.
const MAX_HUNKS = 20
const MAX_HUNK_LINES = 200

function countLines(text: string): number {
  if (text === '') return 0
  return text.replace(/\n$/, '').split('\n').length
}

function capLines(text: string): string {
  const lines = text.split('\n')
  return lines.length > MAX_HUNK_LINES
    ? [...lines.slice(0, MAX_HUNK_LINES), `… ${lines.length - MAX_HUNK_LINES} líneas más`].join('\n')
    : text
}

function relative(path: string, root: string): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** The edits a call made, read from its arguments. */
function hunksOf(tool: string, args: Record<string, unknown>, before: string): Hunk[] {
  switch (tool) {
    case 'Edit':
      return [{ before: String(args.old_string ?? ''), after: String(args.new_string ?? '') }]
    case 'MultiEdit':
      return Array.isArray(args.edits)
        ? (args.edits as { old_string?: unknown; new_string?: unknown }[]).map(edit => ({
            before: String(edit.old_string ?? ''),
            after: String(edit.new_string ?? ''),
          }))
        : []
    case 'Write':
      return [{ before, after: String(args.content ?? '') }]
    case 'NotebookEdit':
      return [{ before: '', after: String(args.new_source ?? '') }]
    default:
      return []
  }
}

/** A unified diff of a file's edits, one `@@` hunk per edit, for the pane's Code. */
function diffOf(file: ChangedFile, root: string): string {
  const path = relative(file.path, root)
  const prefix = (sign: string, text: string) =>
    text === '' ? [] : text.replace(/\n$/, '').split('\n').map(line => sign + line)
  const hunks = file.hunks.map(h => {
    const before = capLines(h.before)
    const after = capLines(h.after)
    return [
      `@@ -1,${countLines(before)} +1,${countLines(after)} @@`,
      ...prefix('-', before),
      ...prefix('+', after),
    ].join('\n')
  })
  return [file.isNew ? '--- /dev/null' : `--- a/${path}`, `+++ b/${path}`, ...hunks].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const root = await $.session.cwd()
    await update($, cwd, () => root)
    await $.command.register({ name: 'cambios', description: 'Muestra u oculta el panel con los archivos que Claude cambió' })
    return result
  })

  on('command.run', { command: 'cambios' }, async $ => {
    if ((await $.ui.panes()).some(p => p.id === PANE.id)) {
      await $.ui.close({ id: PANE.id })
      return { text: 'Panel de cambios cerrado. `/cambios` lo vuelve a abrir.' }
    }
    await $.ui.open(PANE)
    return { text: 'Panel de cambios abierto.' }
  })

  on('tool.call', async ($, e, next) => {
    if (!EDIT_TOOLS.includes(e.tool)) return next(e)
    const args = e as unknown as Record<string, unknown>
    const path = String(args.file_path ?? args.notebook_path ?? '')
    const existed = e.tool === 'Write' ? await $.fs.exists(path) : true
    const before = e.tool === 'Write' && existed ? await $.fs.read(path).catch(() => '') : ''

    const result = await next(e)
    if (result.deny !== undefined || result.isError) return result
    // Installed mid-session, session.start never told us the project's folder.
    if ((await read($, cwd)) === '') {
      const root = await $.session.cwd()
      await update($, cwd, () => root)
    }

    const hunks = hunksOf(e.tool, args, typeof before === 'string' ? before : '')
    const added = hunks.reduce((n, h) => n + countLines(h.after), 0)
    const removed = hunks.reduce((n, h) => n + countLines(h.before), 0)
    const changedAt = await $.clock.now()
    await update($, files, list => {
      const known = list.find(f => f.path === path)
      const file: ChangedFile = known
        ? { ...known, added: known.added + added, removed: known.removed + removed, hunks: [...known.hunks, ...hunks].slice(-MAX_HUNKS), changedAt }
        : { path, isNew: !existed, added, removed, hunks: hunks.slice(-MAX_HUNKS), changedAt }
      return [file, ...list.filter(f => f.path !== path)]
    })
    return result
  })
    // The panel must never stand in an edit's way.
    .catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: 'cambios' }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const list = await read($, files)
    const picked = await read($, selected)
    const root = await read($, cwd)
    const width = e.props.bodyColumns

    if (list.length === 0) {
      return <Text dimColor>Claude aún no ha cambiado archivos en esta sesión.</Text>
    }

    const added = list.reduce((n, f) => n + f.added, 0)
    const removed = list.reduce((n, f) => n + f.removed, 0)
    const current = list.find(f => f.path === picked) ?? list[0]!

    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>
            {list.length} {list.length === 1 ? 'archivo' : 'archivos'}
          </Text>
          <Text color="success"> +{added}</Text>
          <Text color="error"> −{removed}</Text>
          <Text dimColor> · elige uno para ver su diff</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {list.map((file, i) => {
            const counts = `+${file.added} −${file.removed}`
            const name = relative(file.path, root)
            const room = Math.max(10, width - counts.length - 10)
            const shown = name.length > room ? `…${name.slice(-(room - 1))}` : name
            return (
              <Box key={`f${i}`} flexDirection="row" gap={1}>
                <Text color={file.path === current.path ? 'claude' : undefined}>{file.path === current.path ? '▶' : ' '}</Text>
                <Button
                  key={`file${i}`}
                  label={`${file.isNew ? '✚' : '✎'} ${shown}`}
                  onPress={() => update($, selected, () => file.path)}
                />
                <Text color="success">+{file.added}</Text>
                <Text color="error">−{file.removed}</Text>
              </Box>
            )
          })}
        </Box>
        <Box marginTop={1}>
          <Code source={diffOf(current, root)} format="diff" path={relative(current.path, root)} />
        </Box>
      </Box>
    )
  })
}
