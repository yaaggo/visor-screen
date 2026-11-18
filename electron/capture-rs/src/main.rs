mod capture;
mod gpu;

use std::{
    env,
    error::Error,
    io::{self, BufRead},
    sync::mpsc,
    thread,
};
use windows::{
    Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize},
    core::Result as WinResult,
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Preset {
    width: u32,
    height: u32,
    fps: u32,
}

impl Preset {
    fn parse(width: &str, height: &str, fps: &str) -> Result<Self> {
        let preset = Self {
            width: width.parse()?,
            height: height.parse()?,
            fps: fps.parse()?,
        };
        if !(2..=1920).contains(&preset.width)
            || !(2..=1080).contains(&preset.height)
            || !(1..=60).contains(&preset.fps)
        {
            return Err("preset inválido".into());
        }
        Ok(preset)
    }
}

enum Command {
    Frame,
    Release(usize),
    Preset(Preset),
    Stop,
}

fn read_commands(tx: mpsc::Sender<Command>) {
    for line in io::stdin()
        .lock()
        .lines()
        .map_while(std::result::Result::ok)
    {
        let fields: Vec<_> = line.split_ascii_whitespace().collect();
        let command = match fields.as_slice() {
            ["release", slot] => slot.parse().ok().map(Command::Release),
            ["preset", width, height, fps] => {
                Preset::parse(width, height, fps).ok().map(Command::Preset)
            }
            ["stop"] => break,
            _ => None,
        };
        if let Some(command) = command
            && tx.send(command).is_err()
        {
            return;
        }
    }
    let _ = tx.send(Command::Stop);
}

struct Apartment;
impl Apartment {
    fn init() -> WinResult<Self> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED)? };
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

fn run() -> Result<()> {
    let args: Vec<_> = env::args().skip(1).collect();
    let [kind, id, parent, vendor, device, width, height, fps] = args.as_slice() else {
        return Err("uso: visor-capture <window|monitor> <hwnd|x,y> <pid> <vendorId> <deviceId> <largura> <altura> <fps>".into());
    };
    let _apartment = Apartment::init()?;
    let (tx, rx) = mpsc::channel();
    let input = tx.clone();
    thread::spawn(move || read_commands(input));
    capture::run(
        capture::Target::parse(kind, id)?,
        parent.parse()?,
        (vendor.parse()?, device.parse()?),
        Preset::parse(width, height, fps)?,
        tx,
        rx,
    )
}

fn main() {
    if let Err(err) = run() {
        eprintln!("[visor-capture] {err}");
        std::process::exit(1);
    }
}
