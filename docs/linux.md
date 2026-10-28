# Clawd en Linux (Omarchy / Hyprland)

Guía para instalar los mods y dejar a Clawd flotando en un escritorio con
Hyprland, como el de [Omarchy](https://omarchy.org). En otros escritorios la
app también funciona; solo cambia el paso de las reglas de ventana.

## 1. Instalar los mods

Desde la shell, añade el marketplace (se llama `jos-mods`) e instala los mods
que quieras:

```sh
claude plugin marketplace add Jos1704/claude-mods-jos
claude plugin install usage-meters@jos-mods
claude plugin install clawd-buddy@jos-mods
claude plugin install guardian@jos-mods
claude plugin install cambios@jos-mods
claude plugin install bitacora@jos-mods
```

`claude plugin list` debe mostrarlos como `✔ enabled`. Las sesiones de Claude
Code que ya estaban abiertas los cargan al reiniciarse.

## 2. Compilar e instalar la app

Hace falta Rust. En Omarchy (Arch) sirve el paquete `rust` o `rustup`; si no
tienes ninguno:

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
Claude Code si no está corriendo ya (si `clawd-float` no está en el `PATH`, la
busca en `~/.cargo/bin`).

## 3. Hacer que flote en Hyprland

En Wayland una app no puede ponerse "siempre encima" ni elegir su posición: eso
lo decide Hyprland con reglas de ventana. La ventana de Clawd se identifica con
la clase `clawd`.

Desde la 0.55, Hyprland se configura en Lua (`~/.config/hypr/hyprland.lua`) y
es lo que usa Omarchy. Comprueba tu versión con `hyprctl version` y sigue el
apartado que te toque.

### Hyprland 0.55 o posterior (Lua, Omarchy actual)

Añade al final de `~/.config/hypr/hyprland.lua`, después de los `require` de
tus archivos:

```lua
-- Clawd (claude-mods-jos): flotante, en todos los workspaces, sin bordes ni sombra,
-- en la esquina superior derecha (la ventana mide 240 px de ancho).
o.window("^(clawd)$", {
  tag = "-default-opacity",
  float = true,
  pin = true,
  border_size = 0,
  no_shadow = true,
  no_blur = true,
  no_initial_focus = true,
  opacity = "1 1",
  move = { "(monitor_w-264)", 48 },
})
```

Recarga y comprueba que no haya errores (`hyprctl configerrors` no debe
imprimir nada):

```sh
hyprctl reload
hyprctl configerrors
```

| Regla | Para qué |
| --- | --- |
| `float` | Ventana flotante, fuera del tiling. |
| `pin` | Visible en todos los workspaces, como "siempre encima". |
| `border_size = 0`, `no_shadow`, `no_blur` | Sin el marco de Hyprland, para que el fondo transparente se vea limpio. |
| `tag = "-default-opacity"`, `opacity = "1 1"` | Quita la opacidad que Omarchy pone por defecto a todas las ventanas. |
| `no_initial_focus` | No te roba el foco al aparecer. |
| `move = { "(monitor_w-264)", 48 }` | Esquina superior derecha. Cambia las expresiones para otra esquina (por ejemplo `"(monitor_h-218)"` para abajo; la ventana mide 170 px de alto). |

`o.window` es un atajo de Omarchy. Sin Omarchy, usa la función de Hyprland
directamente: `hl.window_rule({ match = { class = "^(clawd)$" }, float = true, ... })`.

Para tenerlo abierto desde que inicias sesión, aunque no hayas abierto Claude
Code, añade en `~/.config/hypr/autostart.lua`:

```lua
o.exec_on_start("clawd-float")
```

### Hyprland 0.48 a 0.54 (hyprlang)

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

# Opcional: abrirlo al iniciar sesión
exec-once = clawd-float
```

Y recarga con `hyprctl reload`. En versiones anteriores a la 0.48 la palabra es
`windowrulev2`. Si algo marca error, revisa la página
[Window Rules](https://wiki.hypr.land/Configuring/Basics/Window-Rules/) de la
wiki de Hyprland para tu versión.

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
| Aparece en mosaico, no flotando | Las reglas no se aplicaron: `hyprctl clients` debe mostrar `class: clawd`, y `hyprctl configerrors` no debe dar errores. Si usas Hyprland 0.55+ con las reglas en `hyprland.conf`, no se leen: pásalas a `hyprland.lua`. |
| Iconos como cuadritos | Falta una fuente con símbolos: `sudo pacman -S noto-fonts`. |
| Lo ocultaste y no vuelve | Escribe `/clawd` en una sesión, o empieza cualquier tarea. |

Para desinstalar la app: `cargo uninstall clawd-float`.
