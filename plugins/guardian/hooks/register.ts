import type { Register } from 'claude-code'

// Two guards, for every session and every subagent:
// - the production guard puts dangerous commands and edits to the person, with
//   Claude Code's own permission dialog, even in auto mode;
// - the secrets shield masks the values in .env files, keys and credentials
//   before the model reads them.

type Rule = { pattern: RegExp; isBlocked?: true; why: string }

const COMMAND_RULES: Rule[] = [
  // Catastrophic: never, whoever asks.
  { pattern: /\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\$HOME|\/\*|\*)(?:\s|$)/i, isBlocked: true, why: 'borraría todo el disco, tu carpeta personal o todo el directorio' },

  // Laravel and databases.
  { pattern: /\bartisan\s+(?:migrate:(?:fresh|reset|refresh|rollback)|db:wipe)\b/, why: 'borra o revierte tablas de la base de datos' },
  { pattern: /\bartisan\b.*\s--force\b/, why: '`--force` salta la protección de producción de Laravel' },
  { pattern: /\b(?:DROP\s+(?:DATABASE|TABLE|SCHEMA)|TRUNCATE(?:\s+TABLE)?)\b/i, why: 'borra datos con SQL' },
  { pattern: /\bDELETE\s+FROM\s+[`"\w.]+(?![^;]*\bWHERE\b)/i, why: 'es un DELETE sin WHERE: borraría la tabla entera' },
  { pattern: /\bUPDATE\s+[`"\w.]+\s+SET\b(?![^;]*\bWHERE\b)/i, why: 'es un UPDATE sin WHERE: cambiaría todas las filas' },

  // Git.
  { pattern: /\bgit\s+push\b.*\s(?:--force(?:-with-lease)?|-f)\b/, why: 'reescribe la historia en el remoto' },
  { pattern: /\bgit\s+push\b.*\b(?:master|main|production|prod)\b/, why: 'sube directo a una rama protegida' },
  { pattern: /\bgit\s+reset\s+--hard\b/, why: 'descarta tus cambios locales' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f/i, why: 'borra los archivos sin seguimiento' },
  { pattern: /\bgit\s+branch\s+-D\b/, why: 'borra una rama aunque no esté fusionada' },
  { pattern: /\bgit\s+(?:checkout\s+--\s+\.|restore\s+\.)/, why: 'descarta tus cambios locales' },

  // Production and deploys.
  { pattern: /(?:^|[\s/._=@-])(?:prod|production)(?:[\s/._=-]|$)/i, why: 'menciona producción' },
  { pattern: /\b(?:envoy\s+run|vapor\s+deploy|forge\s+deploy|dep\s+deploy)\b/, why: 'despliega' },

  // Secrets read through the shell, which the shield cannot mask.
  { pattern: /\b(?:cat|less|more|head|tail|grep|rg|bat|sed|awk|strings|xxd)\b[^|;&]*\.env(?!\.(?:example|sample|dist))\b/, why: 'mostraría tus secretos de .env sin taparlos' },
]

const PROTECTED_FILES: Rule[] = [
  { pattern: /(?:^|\/)\.env\.(?:production|prod)$/, why: 'cambia la configuración de producción' },
  { pattern: /(?:^|\/)\.env$/, why: 'cambia tu archivo .env' },
]

// Files whose values the shield masks before the model reads them.
const DOTENV = /(?:^|\/)\.env(?:\.(?!example$|sample$|dist$)[\w.-]+)?$/
const KEY_FILE = /(?:\.(?:pem|key|p12|pfx)|(?:^|\/)id_(?:rsa|ed25519|ecdsa|dsa))$/
const JSON_SECRETS = /(?:^|\/)(?:auth\.json|[\w.-]*credentials[\w.-]*\.json|[\w.-]*secrets?[\w.-]*\.json)$/
const SECRET_NAME = /pass|pwd|secret|token|key|private|credential|auth|dsn|license|salt|cert/i
// Values that are tokens by their shape, whatever their name: GitHub, Stripe, AWS, Slack, Google, GitLab.
const TOKEN_VALUE = /^(?:gh[pousr]_|github_pat_|[sr]k_(?:live|test)_|pk_live_|whsec_|xox[abprs]-|AKIA|AIza|glpat-)/

function firstMatch(rules: Rule[], text: string): Rule | undefined {
  return rules.find(rule => rule.pattern.test(text))
}

/** Masks a dotenv file: secret-looking values, and the password in any URL. */
function maskDotenv(content: string): { text: string; count: number } {
  let count = 0
  const text = content
    .split('\n')
    .map(line => {
      const match = /^(\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=\s*)(.*)$/.exec(line)
      if (!match) return line
      const [, prefix = '', name = '', value = ''] = match
      const bare = value.replace(/^["']|["']$/g, '').trim()
      if (bare === '' || bare === 'null') return line
      if (SECRET_NAME.test(name) || TOKEN_VALUE.test(bare)) {
        count += 1
        return `${prefix}"•••••• (oculto por el escudo de secretos)"`
      }
      const withoutPassword = value.replace(/(\/\/[^:/\s@]+:)[^@\s]+@/, (_, user: string) => `${user}••••••@`)
      if (withoutPassword !== value) count += 1
      return prefix + withoutPassword
    })
    .join('\n')
  return { text, count }
}

function maskJson(content: string): { text: string; count: number } {
  let count = 0
  const text = content.replace(/("([^"]*)"\s*:\s*)"([^"]*)"/g, (whole, prefix: string, name: string, value: string) => {
    if (!SECRET_NAME.test(name) && !TOKEN_VALUE.test(value)) return whole
    count += 1
    return `${prefix}"•••••• (oculto por el escudo de secretos)"`
  })
  return { text, count }
}

function mask(path: string, content: string): { text: string; count: number } | null {
  if (DOTENV.test(path)) return maskDotenv(content)
  if (JSON_SECRETS.test(path)) return maskJson(content)
  if (KEY_FILE.test(path)) {
    return { text: `[contenido oculto por el escudo de secretos: ${content.split('\n').length} líneas de una clave o certificado]`, count: 1 }
  }
  return null
}

export const register: Register = on => {
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const command = String((e.input as { command?: unknown }).command ?? '')
    const rule = firstMatch(COMMAND_RULES, command)
    if (!rule || verdict.decision === 'deny') return verdict
    return rule.isBlocked
      ? { decision: 'deny', reason: `🛡️ Guardián: bloqueado porque ${rule.why}.` }
      : { decision: 'ask', reason: `🛡️ Guardián: este comando ${rule.why}. ¿Lo dejas correr?` }
  }).catch(() => ({ decision: 'ask', reason: '🛡️ Guardián: no pude revisar este comando. ¿Lo dejas correr?' }))

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (!['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(e.tool)) return verdict
    const input = e.input as { file_path?: unknown; notebook_path?: unknown }
    const path = String(input.file_path ?? input.notebook_path ?? '')
    const rule = firstMatch(PROTECTED_FILES, path)
    if (!rule || verdict.decision === 'deny') return verdict
    return { decision: 'ask', reason: `🛡️ Guardián: este cambio ${rule.why}. ¿Lo permites?` }
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const path = e.file_path
    const isSecret = DOTENV.test(path) || JSON_SECRETS.test(path) || KEY_FILE.test(path)
    const read = await next(e)
    if (!isSecret || read.deny !== undefined || read.isError || read.result.type !== 'text') return read

    const masked = mask(path, read.result.file.content)
    if (masked === null || masked.count === 0) return read
    return {
      // A result of the hook's own, so core maps the masked content, not its record.
      result: { ...read.result, file: { ...read.result.file, content: masked.text } },
      context: [
        `El escudo de secretos tapó ${masked.count} valor(es) de ${path}. Si necesitas uno, pídeselo al usuario; no intentes leerlo por otra vía.`,
      ],
    }
  })
    // If the shield cannot check a secrets file, the model does not get it.
    .catch(($, e) => ({ deny: `El escudo de secretos no pudo revisar ${e.file_path}; no se entregó su contenido.` }))
}
