use crate::{Preset, Result};
use std::{
    rc::Rc,
    slice, thread,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{
            CloseHandle, DUPLICATE_CLOSE_SOURCE, DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE,
            HMODULE,
        },
        Graphics::{
            Direct3D::{
                D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_UNKNOWN,
                D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST, Fxc::D3DCompile, ID3DBlob, ID3DInclude,
            },
            Direct3D11::*,
            Dxgi::{
                Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
                CreateDXGIFactory1, DXGI_SHARED_RESOURCE_READ, DXGI_SHARED_RESOURCE_WRITE,
                IDXGIAdapter, IDXGIFactory1, IDXGIResource1,
            },
        },
        System::Threading::{GetCurrentProcess, OpenProcess, PROCESS_DUP_HANDLE},
    },
    core::{BOOL, Interface, PCSTR, PCWSTR, s},
};

pub type Size = (u32, u32);
const POOL_SIZE: usize = 8;

struct LocalHandle(HANDLE);
impl Drop for LocalHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

// The browser duplicates this handle on import. Close the browser's original
// when the slot is resized or the capture process finishes.
struct RemoteHandle {
    value: HANDLE,
    process: Rc<LocalHandle>,
}
impl Drop for RemoteHandle {
    fn drop(&mut self) {
        let mut local = HANDLE::default();
        unsafe {
            if DuplicateHandle(
                self.process.0,
                self.value,
                GetCurrentProcess(),
                &mut local,
                0,
                false,
                DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE,
            )
            .is_ok()
            {
                let _ = CloseHandle(local);
            }
        }
    }
}

struct Slot {
    texture: ID3D11Texture2D,
    target: ID3D11RenderTargetView,
    handle: RemoteHandle,
    size: Size,
    busy: bool,
}

pub struct PublishedFrame {
    pub slot: usize,
    pub handle: usize,
    pub size: Size,
}

pub struct Gpu {
    pub device: ID3D11Device,
    context: ID3D11DeviceContext,
    parent: Rc<LocalHandle>,
    slots: [Option<Slot>; POOL_SIZE],
    scaler: Scaler,
    fence: ID3D11Query,
}

impl Gpu {
    pub fn new(parent_pid: u32, gpu_id: (u32, u32)) -> Result<Self> {
        let parent = Rc::new(LocalHandle(unsafe {
            OpenProcess(PROCESS_DUP_HANDLE, false, parent_pid)?
        }));
        let adapter = find_adapter(gpu_id)?;
        let driver = if adapter.is_some() {
            D3D_DRIVER_TYPE_UNKNOWN
        } else {
            D3D_DRIVER_TYPE_HARDWARE
        };
        let mut device = None;
        let mut context = None;
        unsafe {
            D3D11CreateDevice(
                adapter.as_ref(),
                driver,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )?
        };
        let device = device.ok_or("dispositivo D3D11 indisponível")?;
        let context = context.ok_or("contexto D3D11 indisponível")?;
        let mut fence = None;
        unsafe {
            device.CreateQuery(
                &D3D11_QUERY_DESC {
                    Query: D3D11_QUERY_EVENT,
                    MiscFlags: 0,
                },
                Some(&mut fence),
            )?;
        }
        Ok(Self {
            scaler: Scaler::new(&device)?,
            device,
            context,
            parent,
            slots: std::array::from_fn(|_| None),
            fence: fence.ok_or("sincronização D3D11 indisponível")?,
        })
    }

    pub fn release(&mut self, id: usize) {
        if let Some(Some(slot)) = self.slots.get_mut(id) {
            slot.busy = false;
        }
    }

    pub fn publish(
        &mut self,
        source: &ID3D11Texture2D,
        input: Size,
        preset: Preset,
    ) -> Result<Option<PublishedFrame>> {
        let output = fit(input, preset);
        let Some((id, slot)) = self
            .slots
            .iter_mut()
            .enumerate()
            .find(|(_, slot)| slot.as_ref().is_none_or(|slot| !slot.busy))
        else {
            return Ok(None);
        };
        if slot.as_ref().is_none_or(|slot| slot.size != output) {
            *slot = Some(Slot::new(&self.device, &self.parent, output)?);
        }
        let slot = slot.as_mut().ok_or("textura compartilhada indisponível")?;
        if input == output {
            copy(&self.context, source, &slot.texture, input);
        } else {
            self.scaler.draw(
                &self.device,
                &self.context,
                source,
                input,
                &slot.target,
                output,
            )?;
        }
        // Shared BGRA textures use no keyed mutex. Publish only after the GPU
        // completed the copy, then wait for Electron's release before reusing.
        unsafe {
            self.context.End(&self.fence);
            self.context.Flush();
            let deadline = Instant::now() + Duration::from_millis(150);
            loop {
                let mut ready = BOOL(0);
                self.context.GetData(
                    &self.fence,
                    Some((&mut ready as *mut BOOL).cast()),
                    size_of::<BOOL>() as u32,
                    D3D11_ASYNC_GETDATA_DONOTFLUSH.0 as u32,
                )?;
                if ready.as_bool() {
                    break;
                }
                if Instant::now() >= deadline {
                    return Err("cópia D3D11 não concluiu".into());
                }
                thread::sleep(Duration::from_micros(250));
            }
        }
        slot.busy = true;
        Ok(Some(PublishedFrame {
            slot: id,
            handle: slot.handle.value.0 as usize,
            size: output,
        }))
    }
}

impl Slot {
    fn new(device: &ID3D11Device, parent: &Rc<LocalHandle>, size: Size) -> Result<Self> {
        let texture = texture(
            device,
            size,
            (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
            (D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED).0 as u32,
        )?;
        let mut target = None;
        unsafe {
            device.CreateRenderTargetView(&texture, None, Some(&mut target))?;
            let resource: IDXGIResource1 = texture.cast()?;
            let local = LocalHandle(resource.CreateSharedHandle(
                None,
                (DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE).0,
                PCWSTR::null(),
            )?);
            let mut remote = HANDLE::default();
            DuplicateHandle(
                GetCurrentProcess(),
                local.0,
                parent.0,
                &mut remote,
                0,
                false,
                DUPLICATE_SAME_ACCESS,
            )?;
            Ok(Self {
                texture,
                target: target.ok_or("render target indisponível")?,
                handle: RemoteHandle {
                    value: remote,
                    process: Rc::clone(parent),
                },
                size,
                busy: false,
            })
        }
    }
}

fn find_adapter(id: (u32, u32)) -> Result<Option<IDXGIAdapter>> {
    if id == (0, 0) {
        return Ok(None);
    }
    let factory: IDXGIFactory1 = unsafe { CreateDXGIFactory1()? };
    for index in 0.. {
        let Ok(adapter) = (unsafe { factory.EnumAdapters1(index) }) else {
            break;
        };
        let desc = unsafe { adapter.GetDesc1()? };
        if (desc.VendorId, desc.DeviceId) == id {
            return Ok(Some(adapter.cast()?));
        }
    }
    Err(format!(
        "adaptador do Electron indisponível: {:04x}:{:04x}",
        id.0, id.1
    )
    .into())
}

fn fit(input: Size, preset: Preset) -> Size {
    let (width, height) = input;
    let factor = (preset.width as f64 / width as f64)
        .min(preset.height as f64 / height as f64)
        .min(1.0);
    let even = |value: u32| ((value as f64 * factor).round() as u32 & !1).max(2);
    (even(width), even(height))
}

fn texture(device: &ID3D11Device, size: Size, binds: u32, misc: u32) -> Result<ID3D11Texture2D> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: size.0,
        Height: size.1,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_DEFAULT,
        BindFlags: binds,
        CPUAccessFlags: 0,
        MiscFlags: misc,
    };
    let mut result = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut result))? };
    result.ok_or_else(|| "textura D3D11 indisponível".into())
}

fn copy(context: &ID3D11DeviceContext, src: &ID3D11Texture2D, dst: &ID3D11Texture2D, size: Size) {
    let rect = D3D11_BOX {
        left: 0,
        top: 0,
        front: 0,
        right: size.0,
        bottom: size.1,
        back: 1,
    };
    unsafe { context.CopySubresourceRegion(dst, 0, 0, 0, 0, src, 0, Some(&rect)) };
}

const SHADERS: &str = "
Texture2D image : register(t0);
SamplerState linearClamp : register(s0);
struct Vertex { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };
Vertex vs(uint id : SV_VertexID) {
    Vertex v;
    v.uv = float2((id << 1) & 2, id & 2);
    v.pos = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return v;
}
float4 ps(Vertex v) : SV_TARGET { return float4(image.Sample(linearClamp, v.uv).rgb, 1); }
";

struct ScaleInput {
    size: Size,
    texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
}

struct Scaler {
    input: Option<ScaleInput>,
    vertex: ID3D11VertexShader,
    pixel: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
}

impl Scaler {
    fn new(device: &ID3D11Device) -> Result<Self> {
        let mut vertex = None;
        let mut pixel = None;
        let mut sampler = None;
        unsafe {
            device.CreateVertexShader(
                &shader(s!("vs"), s!("vs_4_0"))?,
                None::<&ID3D11ClassLinkage>,
                Some(&mut vertex),
            )?;
            device.CreatePixelShader(
                &shader(s!("ps"), s!("ps_4_0"))?,
                None::<&ID3D11ClassLinkage>,
                Some(&mut pixel),
            )?;
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_LINEAR_MIP_POINT,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?;
        }
        Ok(Self {
            input: None,
            vertex: vertex.ok_or("vertex shader indisponível")?,
            pixel: pixel.ok_or("pixel shader indisponível")?,
            sampler: sampler.ok_or("sampler indisponível")?,
        })
    }

    fn draw(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        input_size: Size,
        target: &ID3D11RenderTargetView,
        output: Size,
    ) -> Result<()> {
        if self
            .input
            .as_ref()
            .is_none_or(|input| input.size != input_size)
        {
            let texture = texture(device, input_size, D3D11_BIND_SHADER_RESOURCE.0 as u32, 0)?;
            let mut view = None;
            unsafe { device.CreateShaderResourceView(&texture, None, Some(&mut view))? };
            self.input = Some(ScaleInput {
                size: input_size,
                texture,
                view: view.ok_or("shader resource indisponível")?,
            });
        }
        let input = self
            .input
            .as_ref()
            .ok_or("textura de origem indisponível")?;
        copy(context, source, &input.texture, input_size);
        unsafe {
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&self.vertex, None);
            context.PSSetShader(&self.pixel, None);
            context.PSSetShaderResources(0, Some(&[Some(input.view.clone())]));
            context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            context.OMSetRenderTargets(
                Some(&[Some(target.clone())]),
                None::<&ID3D11DepthStencilView>,
            );
            context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: output.0 as f32,
                Height: output.1 as f32,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            context.Draw(3, 0);
            context.PSSetShaderResources(0, Some(&[None]));
            context.OMSetRenderTargets(None, None::<&ID3D11DepthStencilView>);
        }
        Ok(())
    }
}

fn shader(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>> {
    let mut blob = None;
    unsafe {
        D3DCompile(
            SHADERS.as_ptr().cast(),
            SHADERS.len(),
            PCSTR::null(),
            None,
            None::<&ID3DInclude>,
            entry,
            target,
            0,
            0,
            &mut blob,
            None,
        )?;
        let blob: ID3DBlob = blob.ok_or("shader D3D11 indisponível")?;
        Ok(slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize()).to_vec())
    }
}
