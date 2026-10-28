# claude-mods-jos

Mods para [Claude Code](https://claude.com/claude-code).

| Mod | Qué hace |
| --- | --- |
| **usage-meters** | Bajo la línea de modo de la terminal, tres medidores: contexto del chat, límite de 5 horas y límite semanal, con la hora de reinicio de cada uno. |
| **guardian** | Guardián de producción: pide tu permiso, con el diálogo de Claude Code y aun en modo automático, antes de `migrate:fresh`, `db:wipe`, `--force`, SQL sin `WHERE`, `git push --force` o a `master`, `git reset --hard`, comandos que mencionan producción o cambios a `.env`; bloquea `rm -rf /` y `rm -rf ~`. Escudo de secretos: al leer `.env`, `auth.json`, credenciales o claves, tapa los valores secretos antes de que el modelo los vea. |
| **cambios** | `/cambios` abre un panel con los archivos que Claude creó o editó en la sesión, cuántas líneas añadió y quitó, y el diff del que elijas. Solo dibuja: no gasta tokens. |
| **bitacora** | `/hoy` muestra la bitácora del día (qué le pediste a Claude, por proyecto, a qué hora y cuánto tardó); `/hoy resumen` añade un resumen para tu daily escrito por Haiku. `/costos` muestra el consumo por proyecto de la semana (`hoy`, `mes`, `30d`). Se guarda en `~/.claude/bitacora/`, por equipo. |
| **clawd-buddy** | Clawd, la mascota de Claude, flotando en tu escritorio: muestra qué hace cada sesión abierta (Warp, VS Code, la app de Claude…), sus tareas y el modelo. Un clic te lleva a la sesión. Necesita la app **Clawd** de `apps/clawd-float`. |

## Instalar los mods

En el prompt de una sesión de Claude Code en la terminal:

```
/plugin install usage-meters --marketplace Jos1704/claude-mods-jos
/plugin install clawd-buddy --marketplace Jos1704/claude-mods-jos
/plugin install guardian --marketplace Jos1704/claude-mods-jos
/plugin install cambios --marketplace Jos1704/claude-mods-jos
/plugin install bitacora --marketplace Jos1704/claude-mods-jos
```

O desde la shell:

```sh
claude plugin install usage-meters --marketplace Jos1704/claude-mods-jos
claude plugin install clawd-buddy --marketplace Jos1704/claude-mods-jos
claude plugin install guardian --marketplace Jos1704/claude-mods-jos
claude plugin install cambios --marketplace Jos1704/claude-mods-jos
claude plugin install bitacora --marketplace Jos1704/claude-mods-jos
```

Las sesiones que ya estaban abiertas los cargan al reiniciarse.

## Instalar la app Clawd (macOS)

`clawd-buddy` solo escribe el estado de cada sesión en `~/.claude/clawd/sessions/`; la ventana flotante es una app aparte, en Rust. Necesita [Rust](https://rustup.rs):

```sh
git clone https://github.com/Jos1704/claude-mods-jos.git
cd claude-mods-jos/apps/clawd-float
./build-app.sh
```

Queda instalada en `~/Applications/Clawd.app`, y el mod la abre solo al iniciar Claude Code.

### Uso

- **Arrástralo** a donde quieras, también a otro monitor; recuerda dónde lo dejaste.
- **Clic en una sesión** de la lista para ir a ella (en VS Code abre la ventana de esa carpeta; en iTerm2 y Terminal, la pestaña exacta).
- **Al pasar el mouse**: `× ocultar` lo esconde hasta la siguiente tarea; `al terminar: dormir / ocultar` elige si se queda dormido o desaparece cuando no hay trabajo.
- **`/clawd`** en cualquier sesión lo vuelve a mostrar.

Las sesiones que terminan se quedan 10 segundos en la lista con `✓ Terminó`.

### Cómo se siente Clawd

| Clawd | Cuándo |
| --- | --- |
| Saluda con una burbuja **?** ámbar | Una sesión espera tu permiso o tiene una pregunta para ti. |
| Salta con brillitos **✦** | Acaban de pasar los tests (`artisan test`, `phpunit`, `pest`, `npm test`…). |
| Tiembla con una burbuja **!** roja | Fallaron los tests o falló una herramienta. |
| Suda gotitas azules | El contexto de la sesión pasa del 75 % (a mares desde el 90 %). |

Sonido (apagado de fábrica): con `♪ sonido: sí` al pasar el mouse, suena *Glass* cuando termina una tarea de más de 15 segundos y *Ping* cuando necesita tu permiso.

## Linux

La app también funciona en Linux. Los pasos para instalarla y dejarla flotante en Hyprland (Omarchy) están en [docs/linux.md](docs/linux.md).
