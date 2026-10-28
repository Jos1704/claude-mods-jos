// Clawd flotante: una ventanita siempre encima que muestra lo que Claude Code
// está haciendo. Lee los archivos que el mod `clawd-buddy` escribe en
// ~/.claude/clawd/sessions/<id>.json, uno por sesión.

use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use eframe::egui::{
    self, Align2, Color32, CornerRadius, CursorIcon, FontData, FontDefinitions, FontFamily, FontId,
    Pos2, Rect, Sense, Stroke, StrokeKind, Vec2, ViewportCommand,
};
use serde::{Deserialize, Serialize};

const WINDOW: Vec2 = Vec2::new(240.0, 170.0);
/// Un cuadrante de carácter: más alto que ancho, como en la terminal.
const PIXEL: Vec2 = Vec2::new(7.0, 11.0);
/// Aire sobre Clawd para los saltos y las «z».
const HEADROOM: f32 = 24.0;
const CLAUDE: Color32 = Color32::from_rgb(0xD9, 0x77, 0x57);
const CARD: Color32 = Color32::from_rgba_premultiplied(21, 21, 25, 245);
const TEXT: Color32 = Color32::from_rgb(0xE8, 0xE6, 0xE3);
const BORDER: Color32 = Color32::from_rgb(0x3A, 0x37, 0x34);
const GREEN: Color32 = Color32::from_rgb(0x6C, 0xC0, 0x8B);
const HOVER: Color32 = Color32::from_rgba_premultiplied(40, 38, 36, 120);
/// Cuánto sigue en la lista una sesión que terminó.
const FINISHED_FOR_MS: f64 = 10_000.0;
const MAX_LISTED: usize = 5;
const DIM: Color32 = Color32::from_rgb(0x9A, 0x96, 0x90);

// Clawd, en los mismos caracteres de bloque que dibuja Claude Code: cada
// carácter es un cuadro de 2×2 píxeles.
const HEAD: &str = " ▐▛███▜▌ ";
const HEAD_BLINK: &str = " ▐█████▌ ";
const BODY: &str = "▝▜█████▛▘";
const BODY_ARMS: &str = "▗▟█████▙▖";
const LEGS: [&str; 2] = ["  ▘▘ ▝▝  ", "  ▝▘ ▘▝  "];

// ---------------------------------------------------------------- datos

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Session {
    session_id: String,
    pid: i32,
    tty: String,
    term_program: String,
    bundle_id: String,
    entrypoint: String,
    cwd: String,
    is_working: bool,
    ended: bool,
    activity: Activity,
    tasks: Vec<Task>,
    counts: Counts,
    model: String,
    updated_at: f64,
    work_started_at: f64,
    finished_at: f64,
}

#[derive(Deserialize, Clone, Default)]
#[serde(default)]
struct Activity {
    kind: String,
    detail: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
struct Task {
    subject: String,
    active_form: String,
    status: String,
}

#[derive(Deserialize, Clone, Default)]
#[serde(default)]
struct Counts {
    read: u32,
    write: u32,
    edit: u32,
    run: u32,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct Control {
    show_at: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum IdleMode {
    Sleep,
    Hide,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
struct Settings {
    idle: IdleMode,
    x: Option<f32>,
    y: Option<f32>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { idle: IdleMode::Sleep, x: None, y: None }
    }
}

struct Paths {
    sessions: PathBuf,
    control: PathBuf,
    settings: PathBuf,
}

impl Paths {
    fn new() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        let dir = PathBuf::from(home).join(".claude").join("clawd");
        Paths {
            sessions: dir.join("sessions"),
            control: dir.join("control.json"),
            settings: dir.join("settings.json"),
        }
    }
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &PathBuf) -> T {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn is_alive(pid: i32) -> bool {
    if pid <= 0 {
        return false;
    }
    // kill(pid, 0) solo pregunta si el proceso existe.
    (unsafe { libc::kill(pid, 0) == 0 }) || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn load_sessions(paths: &Paths) -> Vec<Session> {
    let Ok(entries) = fs::read_dir(&paths.sessions) else { return Vec::new() };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| serde_json::from_str::<Session>(&fs::read_to_string(e.path()).ok()?).ok())
        .filter(|s| !s.ended && is_alive(s.pid))
        .collect()
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

/// Las sesiones de la lista: las que trabajan y, por 10 s, las que acaban de terminar.
fn listed(sessions: &[Session], now: f64) -> Vec<Session> {
    let mut list: Vec<Session> = sessions
        .iter()
        .filter(|s| s.is_working || (s.finished_at > 0.0 && now - s.finished_at < FINISHED_FOR_MS))
        .cloned()
        .collect();
    list.sort_by(|a, b| {
        (b.is_working, b.work_started_at)
            .partial_cmp(&(a.is_working, a.work_started_at))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    list
}

fn latest(sessions: &[Session]) -> Option<&Session> {
    sessions.iter().max_by(|a, b| a.updated_at.partial_cmp(&b.updated_at).unwrap_or(std::cmp::Ordering::Equal))
}

// ---------------------------------------------------------------- aspecto

struct Look {
    icon: &'static str,
    verb: &'static str,
    color: Color32,
    props: &'static [&'static str],
}

fn look(kind: &str) -> Look {
    let (icon, verb, color, props): (&str, &str, Color32, &[&str]) = match kind {
        "read" => ("◉", "Leyendo", Color32::from_rgb(0x6C, 0xA0, 0xF0), &["≡", "≣"]),
        "write" => ("✚", "Escribiendo", Color32::from_rgb(0x6C, 0xC0, 0x8B), &["✚", "✦", "✧"]),
        "edit" => ("✎", "Editando", Color32::from_rgb(0xE5, 0xC0, 0x7B), &["✎", "✐"]),
        "run" => ("▶", "Ejecutando", Color32::from_rgb(0xB4, 0x8E, 0xF0), &["›", "»"]),
        "search" => ("⌕", "Buscando", Color32::from_rgb(0x6C, 0xA0, 0xF0), &["⌕", " ⌕"]),
        "web" => ("◍", "Navegando", Color32::from_rgb(0x5C, 0xC8, 0xC8), &["◐", "◓", "◑", "◒"]),
        "agent" => ("◎", "Delegando", Color32::from_rgb(0xB4, 0x8E, 0xF0), &["◎", "○"]),
        "tasks" => ("☰", "Organizando tareas", CLAUDE, &["☐", "☑"]),
        "other" => ("◆", "Usando", CLAUDE, &["◆", "◇"]),
        _ => ("✻", "Pensando", CLAUDE, &["·", "··", "···"]),
    };
    Look { icon, verb, color, props }
}

/// `claude-opus-5-5-20260101[1m]` -> `Opus 5.5`
fn pretty_model(id: &str) -> String {
    let id = id.split('[').next().unwrap_or(id);
    let id = id.strip_prefix("claude-").unwrap_or(id);
    let parts: Vec<&str> = id.split('-').collect();
    let name = parts.iter().find(|p| p.chars().all(|c| c.is_ascii_alphabetic())).copied().unwrap_or(id);
    let version: Vec<&str> =
        parts.iter().filter(|p| p.len() <= 2 && p.chars().all(|c| c.is_ascii_digit())).copied().collect();
    let mut title: String = name.chars().take(1).flat_map(char::to_uppercase).collect();
    title.push_str(&name.chars().skip(1).collect::<String>());
    if version.is_empty() { title } else { format!("{title} {}", version.join(".")) }
}

fn project(cwd: &str) -> &str {
    cwd.trim_end_matches('/').rsplit('/').next().unwrap_or(cwd)
}

/// Cuadrantes encendidos de un carácter de bloque: arriba-izq, arriba-der, abajo-izq, abajo-der.
fn quadrants(c: char) -> [bool; 4] {
    match c {
        '▘' => [true, false, false, false],
        '▝' => [false, true, false, false],
        '▖' => [false, false, true, false],
        '▗' => [false, false, false, true],
        '▌' => [true, false, true, false],
        '▐' => [false, true, false, true],
        '▀' => [true, true, false, false],
        '▄' => [false, false, true, true],
        '▛' => [true, true, true, false],
        '▜' => [true, true, false, true],
        '▙' => [true, false, true, true],
        '▟' => [false, true, true, true],
        '▚' => [true, false, false, true],
        '▞' => [false, true, true, false],
        '█' => [true, true, true, true],
        _ => [false, false, false, false],
    }
}

fn draw_clawd(painter: &egui::Painter, origin: Pos2, rows: [&str; 3], color: Color32) {
    for (row, line) in rows.iter().enumerate() {
        for (col, c) in line.chars().enumerate() {
            for (q, on) in quadrants(c).iter().enumerate() {
                if !on {
                    continue;
                }
                let x = origin.x + (col * 2 + q % 2) as f32 * PIXEL.x;
                let y = origin.y + (row * 2 + q / 2) as f32 * PIXEL.y;
                painter.rect_filled(
                    Rect::from_min_size(Pos2::new(x, y), PIXEL),
                    CornerRadius::ZERO,
                    color,
                );
            }
        }
    }
}

/// Recorta `text` con «…» para que quepa en `width` píxeles.
fn fit(painter: &egui::Painter, text: &str, font: &FontId, width: f32) -> String {
    let measure = |s: &str| painter.layout_no_wrap(s.to_owned(), font.clone(), TEXT).size().x;
    if measure(text) <= width {
        return text.to_owned();
    }
    let mut chars: Vec<char> = text.chars().collect();
    while !chars.is_empty() {
        chars.pop();
        let candidate: String = chars.iter().collect::<String>() + "…";
        if measure(&candidate) <= width {
            return candidate;
        }
    }
    "…".into()
}

// ---------------------------------------------------------------- pantallas

#[cfg(target_os = "macos")]
mod displays {
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct CGRect {
        x: f64,
        y: f64,
        w: f64,
        h: f64,
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGMainDisplayID() -> u32;
        fn CGGetActiveDisplayList(max: u32, displays: *mut u32, count: *mut u32) -> i32;
        fn CGDisplayBounds(display: u32) -> CGRect;
    }

    /// Las pantallas en el espacio de coordenadas global, la principal primero.
    pub fn all() -> Vec<[f32; 4]> {
        let mut ids = [0u32; 16];
        let mut count = 0u32;
        let main = unsafe { CGMainDisplayID() };
        unsafe { CGGetActiveDisplayList(16, ids.as_mut_ptr(), &mut count) };
        let mut list: Vec<u32> = ids[..count as usize].to_vec();
        list.sort_by_key(|id| *id != main);
        list.iter()
            .map(|id| {
                let r = unsafe { CGDisplayBounds(*id) };
                [r.x as f32, r.y as f32, r.w as f32, r.h as f32]
            })
            .collect()
    }
}

#[cfg(not(target_os = "macos"))]
mod displays {
    pub fn all() -> Vec<[f32; 4]> {
        Vec::new()
    }
}

/// Dónde abrir: donde se dejó si sigue dentro de alguna pantalla; si no, arriba a la derecha de la principal.
fn start_position(settings: &Settings) -> Option<Pos2> {
    let screens = displays::all();
    if let (Some(x), Some(y)) = (settings.x, settings.y) {
        let center = Pos2::new(x + WINDOW.x / 2.0, y + WINDOW.y / 2.0);
        let on_screen = screens.is_empty()
            || screens.iter().any(|[sx, sy, sw, sh]| Rect::from_min_size(Pos2::new(*sx, *sy), Vec2::new(*sw, *sh)).contains(center));
        if on_screen {
            return Some(Pos2::new(x, y));
        }
    }
    let [x, y, w, _] = *screens.first()?;
    Some(Pos2::new(x + w - WINDOW.x - 24.0, y + 40.0))
}

// ---------------------------------------------------------------- ir a la sesión

fn osascript(script: &str) {
    let _ = Command::new("osascript").arg("-e").arg(script).spawn();
}

fn app_name(term_program: &str) -> &str {
    match term_program {
        "WarpTerminal" => "Warp",
        "iTerm.app" => "iTerm",
        "Apple_Terminal" => "Terminal",
        "ghostty" => "Ghostty",
        "vscode" => "Visual Studio Code",
        "WezTerm" => "WezTerm",
        _ => "Terminal",
    }
}

/// De dónde viene la sesión, en corto: Warp, VS Code, Claude…
fn source(s: &Session) -> &str {
    match s.bundle_id.as_str() {
        "dev.warp.Warp-Stable" | "dev.warp.Warp" => "Warp",
        "com.microsoft.VSCode" | "com.microsoft.VSCodeInsiders" => "VS Code",
        "com.todesktop.230313mzl4w4u92" => "Cursor",
        "com.anthropic.claudefordesktop" => "Claude",
        "com.googlecode.iterm2" => "iTerm",
        "com.apple.Terminal" => "Terminal",
        "com.mitchellh.ghostty" => "Ghostty",
        _ if s.entrypoint.contains("vscode") => "VS Code",
        _ if s.entrypoint.contains("desktop") => "Claude",
        _ => match s.term_program.as_str() {
            "" => "terminal",
            other => app_name(other),
        },
    }
}

/// Trae al frente la app de la sesión: en iTerm2 y Terminal su pestaña exacta,
/// en VS Code la ventana de su carpeta.
fn focus(session: &Session) {
    if cfg!(target_os = "linux") {
        focus_hyprland(session);
        return;
    }
    if !cfg!(target_os = "macos") {
        return;
    }
    let tty = format!("/dev/{}", session.tty.trim());
    let has_tty = !session.tty.trim().is_empty() && !session.tty.contains('?');
    match source(session) {
        "iTerm" if has_tty => osascript(&format!(
            r#"tell application "iTerm2"
                activate
                repeat with w in windows
                    repeat with t in tabs of w
                        repeat with s in sessions of t
                            if tty of s is "{tty}" then
                                select w
                                select t
                                select s
                                return
                            end if
                        end repeat
                    end repeat
                end repeat
            end tell"#
        )),
        "Terminal" if has_tty => osascript(&format!(
            r#"tell application "Terminal"
                activate
                repeat with w in windows
                    repeat with t in tabs of w
                        if tty of t is "{tty}" then
                            set selected of t to true
                            set index of w to 1
                            return
                        end if
                    end repeat
                end repeat
            end tell"#
        )),
        "VS Code" | "Cursor" if !session.bundle_id.is_empty() => {
            let _ = Command::new("open").arg("-b").arg(&session.bundle_id).arg(&session.cwd).spawn();
        }
        _ if !session.bundle_id.is_empty() => {
            let _ = Command::new("open").arg("-b").arg(&session.bundle_id).spawn();
        }
        _ => {
            let _ = Command::new("open").arg("-a").arg(app_name(&session.term_program)).spawn();
        }
    }
}

/// El proceso padre de `pid`, leído de /proc (Linux).
fn parent_pid(pid: i32) -> Option<i32> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // «pid (nombre) estado ppid …»: el nombre puede llevar espacios, se salta hasta el último «)».
    stat[stat.rfind(')')? + 1..].split_whitespace().nth(1)?.parse().ok()
}

/// En Hyprland: sube de la sesión a sus procesos padre hasta dar con la ventana
/// de la terminal que la contiene, y la enfoca (cambiando de workspace si hace falta).
fn focus_hyprland(session: &Session) {
    if std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_none() {
        return;
    }
    let Ok(out) = Command::new("hyprctl").args(["clients", "-j"]).output() else { return };
    let Ok(clients) = serde_json::from_slice::<Vec<serde_json::Value>>(&out.stdout) else { return };
    let windows: Vec<i64> = clients.iter().filter_map(|c| c["pid"].as_i64()).collect();
    let mut pid = session.pid;
    for _ in 0..32 {
        if windows.contains(&(pid as i64)) {
            let _ = Command::new("hyprctl").args(["dispatch", "focuswindow", &format!("pid:{pid}")]).spawn();
            return;
        }
        match parent_pid(pid) {
            Some(parent) if parent > 1 => pid = parent,
            _ => return,
        }
    }
}

// ---------------------------------------------------------------- app

struct Clawd {
    paths: Paths,
    settings: Settings,
    sessions: Vec<Session>,
    last_scan: Instant,
    /// Ocultado con «×»: vuelve en cuanto empiece otra tarea o con /clawd.
    is_dismissed: bool,
    last_work_started: f64,
    last_show_at: f64,
    is_passthrough: bool,
    last_pos: Option<Pos2>,
    height: f32,
}

impl Clawd {
    fn new(cc: &eframe::CreationContext<'_>) -> Self {
        install_fonts(&cc.egui_ctx);
        let paths = Paths::new();
        let settings: Settings = read_json(&paths.settings);
        let sessions = load_sessions(&paths);
        let control: Control = read_json(&paths.control);
        Clawd {
            last_work_started: sessions.iter().map(|s| s.work_started_at).fold(0.0, f64::max),
            last_show_at: control.show_at,
            sessions,
            last_scan: Instant::now(),
            is_dismissed: false,
            is_passthrough: false,
            last_pos: None,
            height: WINDOW.y,
            paths,
            settings,
        }
    }

    fn scan(&mut self) {
        let sessions = load_sessions(&self.paths);
        let started = sessions.iter().map(|s| s.work_started_at).fold(0.0, f64::max);
        if started > self.last_work_started {
            self.last_work_started = started;
            self.is_dismissed = false;
        }
        let control: Control = read_json(&self.paths.control);
        if control.show_at > self.last_show_at {
            self.last_show_at = control.show_at;
            self.is_dismissed = false;
        }
        self.sessions = sessions;
    }

    fn save_settings(&self) {
        if let Some(dir) = self.paths.settings.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(&self.settings) {
            let _ = fs::write(&self.paths.settings, json);
        }
    }

    fn is_visible(&self) -> bool {
        if self.is_dismissed || self.sessions.is_empty() {
            return false;
        }
        self.settings.idle == IdleMode::Sleep || !listed(&self.sessions, now_ms()).is_empty()
    }

    fn remember_position(&mut self, ctx: &egui::Context) {
        let Some(rect) = ctx.input(|i| i.viewport().outer_rect) else { return };
        if self.last_pos != Some(rect.min) {
            self.last_pos = Some(rect.min);
            self.settings.x = Some(rect.min.x);
            self.settings.y = Some(rect.min.y);
            self.save_settings();
        }
    }
}

fn install_fonts(ctx: &egui::Context) {
    // La fuente por defecto no trae ✎ ☰ ◉…: se añaden las del sistema como respaldo.
    let candidates = [
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Apple Symbols.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/noto/NotoSansSymbols2-Regular.ttf",
        "/usr/share/fonts/noto/NotoSansSymbols-Regular.ttf",
        "/usr/share/fonts/TTF/JetBrainsMonoNerdFont-Regular.ttf",
    ];
    let mut fonts = FontDefinitions::default();
    for path in candidates {
        if let Ok(bytes) = fs::read(path) {
            fonts.font_data.insert(path.into(), Arc::new(FontData::from_owned(bytes)));
            for family in [FontFamily::Proportional, FontFamily::Monospace] {
                fonts.families.entry(family).or_default().push(path.into());
            }
        }
    }
    ctx.set_fonts(fonts);
}

impl eframe::App for Clawd {
    fn clear_color(&self, _visuals: &egui::Visuals) -> [f32; 4] {
        [0.0, 0.0, 0.0, 0.0]
    }

    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        let ctx = &ui.ctx().clone();
        if self.last_scan.elapsed() > Duration::from_millis(300) {
            self.scan();
            self.last_scan = Instant::now();
        }
        self.remember_position(ctx);

        let is_visible = self.is_visible();
        // Oculto = no se dibuja nada y los clics pasan a la ventana de abajo.
        if self.is_passthrough == is_visible {
            self.is_passthrough = !is_visible;
            ctx.send_viewport_cmd(ViewportCommand::MousePassthrough(!is_visible));
        }

        if is_visible {
            self.draw(ui);
        }

        let is_working = is_visible && !listed(&self.sessions, now_ms()).is_empty();
        ctx.request_repaint_after(Duration::from_millis(match (is_visible, is_working) {
            (true, true) => 33,
            (true, false) => 66,
            _ => 300,
        }));
    }
}

/// Una sesión dentro de la tarjeta: su alto ya medido.
struct Block {
    session: Session,
    height: f32,
}

impl Clawd {
    fn draw(&mut self, ui: &mut egui::Ui) {
        let t = ui.input(|i| i.time) as f32;
        let now = now_ms();
        let full = ui.max_rect();
        let painter = ui.painter().clone();
        let listed = listed(&self.sessions, now);
        let shown: Vec<&Session> = listed.iter().take(MAX_LISTED).collect();
        let featured = listed.iter().find(|s| s.is_working);

        // Toda la ventana se arrastra; un clic lleva a la sesión de Clawd.
        let area = ui.interact(full, ui.scope_id().with("clawd"), Sense::click_and_drag());
        if area.drag_started() {
            ui.ctx().send_viewport_cmd(ViewportCommand::StartDrag);
        }
        if area.clicked() {
            if let Some(s) = featured.or(listed.first()).or(latest(&self.sessions)) {
                focus(s);
            }
        }
        let is_hovered = ui.rect_contains_pointer(full);
        if is_hovered {
            ui.ctx().set_cursor_icon(CursorIcon::PointingHand);
        }

        // ---- Clawd, de pie sobre la tarjeta: imita a la sesión que trabaja
        let kind = featured.map(|s| s.activity.kind.as_str()).unwrap_or("");
        let l = look(kind);
        let is_tool = featured.is_some() && !kind.is_empty() && kind != "thinking";
        let is_asleep = listed.is_empty();
        let is_done = featured.is_none() && !is_asleep;

        let art = Vec2::new(18.0 * PIXEL.x, 6.0 * PIXEL.y);
        let card_top = full.top() + HEADROOM + art.y;
        let mut origin = Pos2::new(full.center().x - art.x / 2.0, card_top - art.y + PIXEL.y);
        let is_blinking = (t % 4.0) < 0.15;
        let rows: [&str; 3] = if is_asleep {
            [HEAD_BLINK, BODY, LEGS[0]]
        } else if is_done {
            // Terminó: brazos arriba, contento.
            [if is_blinking { HEAD_BLINK } else { HEAD }, BODY_ARMS, LEGS[0]]
        } else if is_tool {
            origin.x += (t * 2.2).sin() * 34.0;
            let step = ((t / 0.18) as usize) % 2;
            let arms = ((t / 0.3) as usize) % 2 == 0;
            [if is_blinking { HEAD_BLINK } else { HEAD }, if arms { BODY_ARMS } else { BODY }, LEGS[step]]
        } else {
            origin.y -= (t * 5.0).sin().abs() * 8.0;
            [if is_blinking { HEAD_BLINK } else { HEAD }, BODY, LEGS[0]]
        };

        let prop_at = Pos2::new(origin.x + art.x + 4.0, origin.y + 3.0 * PIXEL.y);
        if is_asleep {
            for i in 0..3 {
                let phase = (t * 0.5 + i as f32 / 3.0).fract();
                let pos = Pos2::new(origin.x + art.x - 6.0 + phase * 18.0, origin.y + 6.0 - phase * 26.0);
                let alpha = ((1.0 - phase) * 230.0) as u8;
                painter.text(
                    pos,
                    Align2::LEFT_BOTTOM,
                    "z",
                    FontId::proportional(11.0 + phase * 7.0),
                    Color32::from_rgba_unmultiplied(0xC8, 0xC4, 0xBE, alpha),
                );
            }
        } else if is_done {
            painter.text(prop_at, Align2::LEFT_CENTER, "✓", FontId::proportional(16.0), GREEN);
        } else {
            let prop = l.props[((t / 0.3) as usize) % l.props.len()];
            painter.text(prop_at, Align2::LEFT_CENTER, prop, FontId::proportional(16.0), l.color);
        }

        // ---- medir la tarjeta
        let name = FontId::proportional(13.5);
        let small = FontId::proportional(12.0);
        let tiny = FontId::proportional(11.0);
        let pad = 10.0;
        let gap = 5.0;
        let line_h = |f: &FontId| f.size + gap;
        let block_h = |s: &Session| {
            let mut h = line_h(&name) + line_h(&small);
            if s.is_working && !s.tasks.is_empty() {
                h += 6.0 + gap + 4.0;
                if s.tasks.iter().any(|t| t.status == "in_progress") {
                    h += line_h(&small);
                }
            }
            h
        };
        let blocks: Vec<Block> = shown.iter().map(|s| Block { session: (*s).clone(), height: block_h(s) }).collect();
        let divider = 9.0;
        let mut body_h: f32 = blocks.iter().map(|b| b.height).sum::<f32>() + divider * blocks.len().saturating_sub(1) as f32;
        if blocks.is_empty() {
            body_h = line_h(&name);
        }
        let more = listed.len().saturating_sub(MAX_LISTED);
        if more > 0 {
            body_h += line_h(&small);
        }
        let card_h = pad + body_h + 8.0 + line_h(&tiny) + pad - gap;
        let card = Rect::from_min_size(Pos2::new(full.left() + 4.0, card_top), Vec2::new(full.width() - 8.0, card_h));

        // La ventana se ajusta a la tarjeta.
        let wanted = (card.bottom() - full.top() + 4.0).ceil();
        if (wanted - self.height).abs() > 0.5 {
            self.height = wanted;
            ui.ctx().send_viewport_cmd(ViewportCommand::InnerSize(Vec2::new(WINDOW.x, wanted)));
        }

        painter.rect(card, CornerRadius::same(12), CARD, Stroke::new(1.0, BORDER), StrokeKind::Inside);
        draw_clawd(&painter, origin, rows, CLAUDE);

        // ---- una fila por sesión
        let width = card.width() - pad * 2.0;
        let x = card.left() + pad;
        let mut y = card.top() + pad;
        if blocks.is_empty() {
            painter.text(Pos2::new(x, y), Align2::LEFT_TOP, "☾ Durmiendo…", name.clone(), DIM);
        }
        for (i, block) in blocks.iter().enumerate() {
            let s = &block.session;
            if i > 0 {
                let line_y = y - divider / 2.0 - 1.0;
                painter.hline(card.left() + pad..=card.right() - pad, line_y, Stroke::new(1.0, BORDER));
            }
            let rect = Rect::from_min_size(Pos2::new(card.left(), y - 4.0), Vec2::new(card.width(), block.height + 4.0));
            let row = ui.interact(rect, ui.scope_id().with(("session", &s.session_id)), Sense::click_and_drag());
            if row.drag_started() {
                ui.ctx().send_viewport_cmd(ViewportCommand::StartDrag);
            }
            if row.clicked() {
                focus(s);
            }
            if row.hovered() {
                painter.rect_filled(rect.shrink2(Vec2::new(4.0, 0.0)), CornerRadius::same(6), HOVER);
            }

            let sl = look(if s.is_working { &s.activity.kind } else { "" });
            // Fila 1: proyecto y de dónde viene.
            let origin_label = source(s);
            let origin_w = painter.layout_no_wrap(origin_label.to_owned(), tiny.clone(), DIM).size().x;
            painter.text(Pos2::new(card.right() - pad, y + 1.5), Align2::RIGHT_TOP, origin_label, tiny.clone(), DIM);
            let title = fit(&painter, project(&s.cwd), &name, width - origin_w - 8.0);
            painter.text(Pos2::new(x, y), Align2::LEFT_TOP, title, name.clone(), TEXT);
            y += line_h(&name);

            // Fila 2: qué hace, o que ya terminó.
            if s.is_working {
                let verb = format!("{} {}", sl.icon, sl.verb);
                let verb_w = painter.layout_no_wrap(verb.clone(), small.clone(), sl.color).size().x;
                painter.text(Pos2::new(x, y), Align2::LEFT_TOP, &verb, small.clone(), sl.color);
                let is_tool = !s.activity.kind.is_empty() && s.activity.kind != "thinking";
                if is_tool && !s.activity.detail.is_empty() && verb_w + 12.0 < width {
                    let detail = fit(&painter, &s.activity.detail, &small, width - verb_w - 6.0);
                    painter.text(Pos2::new(x + verb_w + 6.0, y), Align2::LEFT_TOP, detail, small.clone(), DIM);
                }
            } else {
                let ago = ((now - s.finished_at) / 1000.0).max(0.0).round() as u32;
                painter.text(Pos2::new(x, y), Align2::LEFT_TOP, "✓ Terminó", small.clone(), GREEN);
                let w = painter.layout_no_wrap("✓ Terminó".into(), small.clone(), GREEN).size().x;
                painter.text(Pos2::new(x + w + 6.0, y), Align2::LEFT_TOP, format!("hace {ago}s"), small.clone(), DIM);
            }
            y += line_h(&small);

            // Fila 3: tareas.
            if s.is_working && !s.tasks.is_empty() {
                let done = s.tasks.iter().filter(|t| t.status == "completed").count();
                let total = s.tasks.len();
                let label = format!("{done}/{total}");
                let label_w = painter.layout_no_wrap(label.clone(), tiny.clone(), TEXT).size().x;
                let track = Rect::from_min_size(Pos2::new(x, y + 2.0), Vec2::new(width - label_w - 8.0, 5.0));
                painter.rect_filled(track, CornerRadius::same(3), Color32::from_rgb(0x3A, 0x38, 0x36));
                let filled = Rect::from_min_size(track.min, Vec2::new(track.width() * done as f32 / total as f32, track.height()));
                painter.rect_filled(filled, CornerRadius::same(3), CLAUDE);
                painter.text(Pos2::new(card.right() - pad, y - 2.0), Align2::RIGHT_TOP, label, tiny.clone(), TEXT);
                y += 6.0 + gap + 4.0;
                if let Some(task) = s.tasks.iter().find(|t| t.status == "in_progress") {
                    let text = if task.active_form.is_empty() { &task.subject } else { &task.active_form };
                    painter.text(Pos2::new(x, y), Align2::LEFT_TOP, fit(&painter, text, &small, width), small.clone(), DIM);
                    y += line_h(&small);
                }
            }
            y += divider;
        }
        if more > 0 {
            painter.text(Pos2::new(x, y - divider), Align2::LEFT_TOP, format!("+{more} más"), small.clone(), DIM);
        }

        // ---- pie: modelo y sesiones, o los controles al pasar el mouse
        let foot_y = card.bottom() - pad;
        if is_hovered {
            let idle_label = match self.settings.idle {
                IdleMode::Sleep => "☾ al terminar: dormir",
                IdleMode::Hide => "○ al terminar: ocultar",
            };
            let link = |text: &str| egui::Button::new(egui::RichText::new(text).size(11.5).color(TEXT)).frame(false);
            let toggle = ui.put(Rect::from_min_max(Pos2::new(x - 2.0, foot_y - 16.0), Pos2::new(x + 150.0, foot_y + 2.0)), link(idle_label));
            if toggle.clicked() {
                self.settings.idle = match self.settings.idle {
                    IdleMode::Sleep => IdleMode::Hide,
                    IdleMode::Hide => IdleMode::Sleep,
                };
                self.save_settings();
            }
            let hide = ui.put(Rect::from_min_max(Pos2::new(card.right() - pad - 64.0, foot_y - 16.0), Pos2::new(card.right() - pad + 2.0, foot_y + 2.0)), link("× ocultar"));
            if hide.clicked() {
                self.is_dismissed = true;
            }
        } else {
            let model = featured.or(latest(&self.sessions)).map(|s| s.model.as_str()).unwrap_or("");
            let open = self.sessions.len();
            let footer = format!(
                "{} · {} {}",
                pretty_model(if model.is_empty() { "claude" } else { model }),
                open,
                if open == 1 { "sesión abierta" } else { "sesiones abiertas" }
            );
            painter.text(Pos2::new(x, foot_y), Align2::LEFT_BOTTOM, fit(&painter, &footer, &tiny, width), tiny.clone(), DIM);
        }
    }
}

fn main() -> eframe::Result {
    let settings: Settings = read_json(&Paths::new().settings);
    let mut viewport = egui::ViewportBuilder::default()
        .with_title("Clawd")
        // La «class» de la ventana en Linux: con ella las reglas de Hyprland la reconocen.
        .with_app_id("clawd")
        .with_inner_size(WINDOW)
        .with_decorations(false)
        .with_transparent(true)
        .with_always_on_top()
        .with_resizable(false)
        .with_has_shadow(false)
        .with_taskbar(false);
    if let Some(pos) = start_position(&settings) {
        viewport = viewport.with_position(pos);
    }
    eframe::run_native(
        "Clawd",
        eframe::NativeOptions { viewport, ..Default::default() },
        Box::new(|cc| Ok(Box::new(Clawd::new(cc)))),
    )
}
