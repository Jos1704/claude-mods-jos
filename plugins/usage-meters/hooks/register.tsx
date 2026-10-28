import { atom, read, update } from 'claude-code'
import type { Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { Meter, Usage } from '../types'

const usage = atom({ plugin: 'usage-meters', key: 'usage' } as const, {
  context: null,
  fiveHour: null,
  weekly: null,
})

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']
const BAR_WIDTH = 8

function toUsage(context: SessionContextUsage, limits: readonly SessionRateLimit[]): Usage {
  const limit = (kind: string): Meter | null => {
    const found = limits.find(l => l.kind === kind)
    return found ? { percent: found.percentUsed, resetsAt: found.resetsAt } : null
  }

  return {
    context: context.percent === undefined ? null : { percent: context.percent },
    fiveHour: limit('five_hour'),
    weekly: limit('seven_day'),
  }
}

function bar(percent: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((percent / 100) * BAR_WIDTH)))
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled)
}

type MeterColor = 'suggestion' | 'claude' | 'autoAccept'

// Each meter keeps its own color until it is nearly spent.
function colorFor(percent: number, own: MeterColor): MeterColor | 'error' {
  return percent >= 85 ? 'error' : own
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`
}

function resetLabel(resetsAt: string | undefined, withDay: boolean): string {
  if (!resetsAt) return ''
  const d = new Date(resetsAt)
  if (Number.isNaN(d.getTime())) return ''
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return withDay ? ` ↻ ${DAYS[d.getDay()]} ${time}` : ` ↻ ${time}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    const now = await $.session.usage()
    await update($, usage, () => toUsage(now.context, now.rateLimits))
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, usage, () => toUsage(e.context, e.rateLimits))
    return next(e)
  })

  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const engineLine = await next(e)
    const u = await read($, usage)
    const { Box, Text } = $.ui.resolve(e)

    const meter = (label: string, own: MeterColor, m: Meter | null, reset: string) =>
      m === null ? (
        <Text>
          <Text color={own}>{label}</Text>
          <Text dimColor> —</Text>
        </Text>
      ) : (
        <Text>
          <Text color={own}>{label} </Text>
          <Text color={colorFor(m.percent, own)}>{bar(m.percent)}</Text>
          <Text> {Math.round(m.percent)}%</Text>
          <Text dimColor>{reset}</Text>
        </Text>
      )

    return (
      <Box flexDirection="column">
        {engineLine}
        <Box flexDirection="row" gap={3}>
          {meter('ctx', 'suggestion', u.context, '')}
          {meter('5h', 'claude', u.fiveHour, resetLabel(u.fiveHour?.resetsAt, false))}
          {meter('sem', 'autoAccept', u.weekly, resetLabel(u.weekly?.resetsAt, true))}
        </Box>
      </Box>
    )
  })
}
