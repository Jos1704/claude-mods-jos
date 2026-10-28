# claude-mods-jos

Mods para [Claude Code](https://claude.com/claude-code).

| Mod | Qué hace |
| --- | --- |
| **usage-meters** | Bajo la línea de modo de la terminal, tres medidores: contexto del chat, límite de 5 horas y límite semanal, con la hora de reinicio de cada uno. |
| **clawd-buddy** | Clawd, la mascota de Claude, flotando en tu escritorio: muestra qué hace cada sesión abierta (Warp, VS Code, la app de Claude…), sus tareas y el modelo. Un clic te lleva a la sesión. Necesita la app **Clawd** de `apps/clawd-float`. |

## Instalar los mods

En el prompt de una sesión de Claude Code en la terminal:

```
/plugin install usage-meters --marketplace Jos1704/claude-mods-jos
/plugin install clawd-buddy --marketplace Jos1704/claude-mods-jos
```

O desde la shell:

```sh
claude plugin install usage-meters --marketplace Jos1704/claude-mods-jos
claude plugin install clawd-buddy --marketplace Jos1704/claude-mods-jos
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

## Linux

La app también funciona en Linux. Los pasos para instalarla y dejarla flotante en Hyprland (Omarchy) están en [docs/linux.md](docs/linux.md).
