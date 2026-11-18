use crate::{Command, Preset, Result, gpu::Gpu};
use std::{
    io::{self, Write},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};
use windows::{
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{
            Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureAccess,
            GraphicsCaptureAccessKind, GraphicsCaptureItem, GraphicsCaptureSession,
        },
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Security::Authorization::AppCapabilityAccess::AppCapabilityAccessStatus,
    Win32::{
        Foundation::{HWND, POINT},
        Graphics::{
            Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Texture2D},
            Dxgi::IDXGIDevice,
            Gdi::{MONITOR_DEFAULTTONULL, MonitorFromPoint},
        },
        System::{
            Threading::{ABOVE_NORMAL_PRIORITY_CLASS, GetCurrentProcess, SetPriorityClass},
            WinRT::{
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
        },
        UI::WindowsAndMessaging::IsWindow,
    },
    core::{Interface, factory},
};

const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
const FRAME_BUFFERS: i32 = 2;

pub enum Target {
    Window(usize),
    Monitor(i32, i32),
}

impl Target {
    pub fn parse(kind: &str, id: &str) -> Result<Self> {
        match kind {
            "window" => Ok(Self::Window(id.parse()?)),
            "monitor" => {
                let (x, y) = id
                    .split_once(',')
                    .ok_or("coordenadas do monitor inválidas")?;
                Ok(Self::Monitor(x.parse()?, y.parse()?))
            }
            _ => Err("fonte inválida".into()),
        }
    }

    fn is_open(&self) -> bool {
        match *self {
            Self::Window(id) => unsafe { IsWindow(Some(HWND(id as *mut _))).as_bool() },
            Self::Monitor(..) => true,
        }
    }

    fn open(&self) -> Result<GraphicsCaptureItem> {
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
        unsafe {
            match *self {
                Self::Window(id) => {
                    let hwnd = HWND(id as *mut _);
                    if !self.is_open() {
                        return Err("janela indisponível".into());
                    }
                    Ok(interop.CreateForWindow(hwnd)?)
                }
                Self::Monitor(x, y) => {
                    let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL);
                    if monitor.0.is_null() {
                        return Err("monitor indisponível".into());
                    }
                    Ok(interop.CreateForMonitor(monitor)?)
                }
            }
        }
    }
}

fn period(fps: u32) -> Duration {
    Duration::from_secs_f64(1.0 / f64::from(fps))
}

#[derive(Default)]
struct Counts {
    captured: u32,
    sent: u32,
    busy: u32,
}

pub fn run(
    target: Target,
    parent: u32,
    gpu_id: (u32, u32),
    mut preset: Preset,
    tx: mpsc::Sender<Command>,
    rx: mpsc::Receiver<Command>,
) -> Result<()> {
    if !GraphicsCaptureSession::IsSupported()? {
        return Err("Windows Graphics Capture indisponível".into());
    }
    let access =
        GraphicsCaptureAccess::RequestAccessAsync(GraphicsCaptureAccessKind::Borderless)?.join()?;
    if access != AppCapabilityAccessStatus::Allowed {
        return Err("O Windows não autorizou a captura Rust sem borda".into());
    }
    let _ = unsafe { SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS) };
    let mut gpu = Gpu::new(parent, gpu_id)?;
    let dxgi: IDXGIDevice = gpu.device.cast()?;
    let device: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let item = target.open()?;
    let mut size = item.Size()?;
    if size.Width < 2 || size.Height < 2 {
        return Err("fonte sem imagem".into());
    }
    let pool =
        Direct3D11CaptureFramePool::CreateFreeThreaded(&device, FORMAT, FRAME_BUFFERS, size)?;
    let pending = Arc::new(AtomicBool::new(false));
    let arriving = Arc::clone(&pending);
    let frames = tx.clone();
    let frame_event = pool.FrameArrived(&TypedEventHandler::new(move |_, _| {
        if !arriving.swap(true, Ordering::AcqRel) {
            let _ = frames.send(Command::Frame);
        }
        Ok(())
    }))?;
    let closed_event = item.Closed(&TypedEventHandler::new(move |_, _| {
        let _ = tx.send(Command::Stop);
        Ok(())
    }))?;
    let session = pool.CreateCaptureSession(&item)?;
    session.SetIsBorderRequired(false)?;
    if session.IsBorderRequired()? {
        return Err("O Windows manteve a borda da captura".into());
    }
    // On older Windows this property is unavailable. The sender still enforces
    // the preset rate below, independently of the compositor's arrival rate.
    let _ = session.SetMinUpdateInterval(TimeSpan { Duration: 10_000 });
    session.StartCapture()?;
    let epoch = Instant::now();
    let mut deadline = epoch;
    let mut clock_offset = None;
    let mut latest: Option<Direct3D11CaptureFrame> = None;
    let mut counts = Counts::default();
    let mut sample_time = Instant::now();
    let mut stdout = io::stdout().lock();
    let result = (|| -> Result<()> {
        loop {
            if Instant::now() >= deadline {
                if let Some(frame) = latest.take() {
                    let resized = frame.ContentSize()?;
                    // Keep the system media clock used for A/V synchronization.
                    let elapsed = deadline.duration_since(epoch).as_micros() as i64;
                    let source_time = frame.SystemRelativeTime()?.Duration / 10;
                    let timestamp = elapsed + *clock_offset.get_or_insert(source_time - elapsed);
                    if resized.Width >= 2 && resized.Height >= 2 {
                        match publish(&mut gpu, &frame, resized, preset)? {
                            Some(output) => {
                                writeln!(
                                    stdout,
                                    "{{\"type\":\"frame\",\"slot\":{},\"handle\":\"{:x}\",\"width\":{},\"height\":{},\"timestamp\":{timestamp}}}",
                                    output.slot, output.handle, output.size.0, output.size.1
                                )?;
                                stdout.flush()?;
                                counts.sent += 1;
                            }
                            None => counts.busy += 1,
                        }
                        if resized != size {
                            drop(frame);
                            pool.Recreate(&device, FORMAT, FRAME_BUFFERS, resized)?;
                            size = resized;
                        }
                    }
                }
                deadline += period(preset.fps);
                if deadline <= Instant::now() {
                    deadline = Instant::now() + period(preset.fps);
                }
            }
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(Command::Frame) => {
                    pending.store(false, Ordering::Release);
                    for _ in 0..FRAME_BUFFERS {
                        let Ok(frame) = pool.TryGetNextFrame() else {
                            break;
                        };
                        counts.captured += 1;
                        latest = Some(frame);
                    }
                }
                Ok(Command::Release(slot)) => gpu.release(slot),
                Ok(Command::Preset(new_preset)) => {
                    preset = new_preset;
                    deadline = Instant::now();
                }
                Ok(Command::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let elapsed = sample_time.elapsed().as_secs_f64();
            if elapsed >= 1.0 {
                if !target.is_open() {
                    break;
                }
                writeln!(
                    stdout,
                    "{{\"type\":\"stats\",\"source\":{:.0},\"shared\":{:.0},\"busy\":{},\"borderless\":true}}",
                    f64::from(counts.captured) / elapsed,
                    f64::from(counts.sent) / elapsed,
                    counts.busy
                )?;
                stdout.flush()?;
                counts = Counts::default();
                sample_time = Instant::now();
            }
        }
        Ok(())
    })();
    let _ = item.RemoveClosed(closed_event);
    let _ = pool.RemoveFrameArrived(frame_event);
    let _ = session.Close();
    let _ = pool.Close();
    result
}

fn publish(
    gpu: &mut Gpu,
    frame: &Direct3D11CaptureFrame,
    size: SizeInt32,
    preset: Preset,
) -> Result<Option<crate::gpu::PublishedFrame>> {
    let surface: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    let texture: ID3D11Texture2D = unsafe { surface.GetInterface()? };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { texture.GetDesc(&mut desc) };
    // Until the frame pool is resized the GPU surface can be smaller than ContentSize.
    let width = (size.Width as u32).min(desc.Width);
    let height = (size.Height as u32).min(desc.Height);
    gpu.publish(&texture, (width, height), preset)
}
