# Clawd en Linux (Omarchy / Hyprland)

Guía para instalar los mods y dejar a Clawd flotando en un escritorio con
Hyprland, como el de [Omarchy](https://omarchy.org). En otros escritorios la
app también funciona; solo cambia el paso de las reglas de ventana.

## 1. Instalar los mods

Igual que en macOS, en el prompt de Claude Code:

```
/plugin install usage-meters --marketplace Jos1704/claude-mods-jos
/plugin install clawd-buddy --marketplace Jos1704/claude-mods-jos
```

## 2. Compilar e instalar la app

Hace falta Rust. En Omarchy (Arch):

```sh
sudo pacman -S --needed rustup base-devel
rustup default stable
```

Luego:

```sh
git clone https://github.com/Jos1704/claude-mods-jos.git
cd claude-mods-jos/apps/clawd-float
cargo install --path .
```

Eso deja el ejecutable en `~/.cargo/bin/clawd-float`. Comprueba que esa
carpeta esté en tu `PATH` (`which clawd-float`); si no, añade a tu
`~/.bashrc` o `~/.zshrc`:

```sh
export PATH="$HOME/.cargo/bin:$PATH"
```

No hace falta abrirla a mano: `clawd-buddy` la arranca al iniciar cada sesión de
Claude Code si no está corriendo ya.

## 3. Hacer que flote en Hyprland

En Wayland una app no puede ponerse "siempre encima" ni elegir su posición: eso
lo decide Hyprland con reglas de ventana. La ventana de Clawd se identifica con
la clase `clawd`.

Añade al final de `~/.config/hypr/hyprland.conf`:

```ini
# Clawd: flotante, en todos los workspaces, sin bordes ni sombra
windowrule = float, class:^(clawd)$
windowrule = pin, class:^(clawd)$
windowrule = noborder, class:^(clawd)$
windowrule = noshadow, class:^(clawd)$
windowrule = noblur, class:^(clawd)$
windowrule = noinitialfocus, class:^(clawd)$
windowrule = move 100%-264 48, class:^(clawd)$
```

Y recarga con `hyprctl reload`.

| Regla | Para qué |
| --- | --- |
| `float` | Ventana flotante, fuera del tiling. |
| `pin` | Visible en todos los workspaces, como "siempre encima". |
| `noborder`, `noshadow`, `noblur` | Sin el marco de Hyprland, para que el fondo transparente se vea limpio. |
| `noinitialfocus` | No te roba el foco al aparecer. |
| `move 100%-264 48` | Esquina superior derecha (la ventana mide 240 px de ancho). Cambia los números para otra esquina. |

> Hyprland ha cambiado la sintaxis de las reglas entre versiones (`windowrulev2`
> en las antiguas, `windowrule` con la misma forma desde la 0.48). Si
> `hyprctl reload` marca errores en estas líneas, revisa la página
> [Window Rules](https://wiki.hypr.land/Configuring/Window-Rules/) de la wiki de
> Hyprland para tu versión (`hyprctl version`).

Para tenerlo abierto desde que inicias sesión, aunque no hayas abierto Claude
Code, añade también:

```ini
exec-once = clawd-float
```

## 4. Uso

Es igual que en macOS (ver el [README](../README.md#uso)), con una diferencia:

- **Clic en una sesión**: Clawd busca, subiendo desde el proceso de Claude Code,
  la ventana de terminal que la contiene y la enfoca con
  `hyprctl dispatch focuswindow`, cambiando de workspace si hace falta. Enfoca la
  ventana, no una pestaña dentro de ella; y en terminales que llevan todas sus
  ventanas en un solo proceso (Ghostty, por ejemplo) enfoca la primera de ellas.
- **Arrastrar** lo mueve mientras la sesión dure, pero en Wayland la posición al
  abrir la decide la regla `move` de arriba.

## Si algo no va

| Síntoma | Qué revisar |
| --- | --- |
| No aparece | Ejecuta `clawd-float` en una terminal para ver sus errores. Comprueba que haya sesiones en `ls ~/.claude/clawd/sessions/`: las sesiones de Claude Code abiertas antes de instalar el mod no aparecen hasta reiniciarlas. |
| Aparece en mosaico, no flotando | Las reglas no se aplicaron: `hyprctl clients` debe mostrar `class: clawd`, y `hyprctl reload` no debe dar errores. |
| Iconos como cuadritos | Falta una fuente con símbolos: `sudo pacman -S noto-fonts`. |
| Lo ocultaste y no vuelve | Escribe `/clawd` en una sesión, o empieza cualquier tarea. |

Para desinstalar la app: `cargo uninstall clawd-float`.
