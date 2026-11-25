//! WASAPI shared-mode render output fed by a lock-free ring.
//!
//! Clubify used to wrap audify/RtAudio, which fixed its native queue at a few
//! frames and silently played zeros when JavaScript missed a callback. This
//! module owns the whole render path instead: JavaScript pushes processed
//! interleaved float32 into a one-second ring, a dedicated render thread wakes
//! on the WASAPI event, and underruns are measured where they actually happen.

use std::{
    cell::UnsafeCell,
    ffi::c_void,
    ptr,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::{w, PCWSTR, PWSTR},
    Win32::{
        Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
        Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT},
        Media::{
            Audio::{
                eConsole, eRender, IAudioClient, IAudioRenderClient, IMMDevice,
                IMMDeviceCollection, IMMDeviceEnumerator, MMDeviceEnumerator,
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                DEVICE_STATE_ACTIVE, WAVEFORMATEX,
            },
            Multimedia::WAVE_FORMAT_IEEE_FLOAT,
        },
        System::{
            Com::StructuredStorage::{PropVariantClear, PROPVARIANT},
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_ALL,
                COINIT_MULTITHREADED, STGM_READ,
            },
            Threading::{
                AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateEventW,
                SetEvent, WaitForMultipleObjects,
            },
            Variant::VT_LPWSTR,
        },
        UI::Shell::PropertiesSystem::IPropertyStore,
    },
};

const CHANNELS: u16 = 2;
const OPEN_TIMEOUT: Duration = Duration::from_secs(5);
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const RING_SECONDS: u32 = 1;

#[derive(Clone, Debug)]
pub struct OutputDevice {
    pub name: String,
    pub is_default: bool,
    pub channels: u16,
    pub sample_rate: u32,
}

#[derive(Clone, Debug)]
pub struct Opened {
    pub device_name: String,
    pub sample_rate: u32,
    pub period_frames: u32,
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct OutputStats {
    pub fill_frames: u64,
    pub capacity_frames: u64,
    pub underruns: u64,
    pub silent_frames: u64,
    pub dropped_frames: u64,
    pub fatal: Option<String>,
}

/// Single-producer (JS thread) / single-consumer (render thread) frame ring.
/// Positions are monotonic frame counters; the capacity is a power of two.
struct Ring {
    capacity: usize,
    mask: usize,
    data: UnsafeCell<Box<[f32]>>,
    write: AtomicU64,
    read: AtomicU64,
}

// SAFETY: the producer only touches the region beyond `write`, the consumer
// only the region below it, and both publish positions with Release ordering.
unsafe impl Sync for Ring {}

impl Ring {
    fn new(capacity_frames: usize) -> Arc<Self> {
        let capacity = capacity_frames.max(1024).next_power_of_two();
        Arc::new(Self {
            capacity,
            mask: capacity - 1,
            data: UnsafeCell::new(vec![0.0; capacity * CHANNELS as usize].into_boxed_slice()),
            write: AtomicU64::new(0),
            read: AtomicU64::new(0),
        })
    }

    fn available(&self) -> usize {
        (self
            .write
            .load(Ordering::Acquire)
            .wrapping_sub(self.read.load(Ordering::Acquire))) as usize
    }

    /// Copies interleaved stereo frames and returns how many fit.
    fn push(&self, samples: &[f32]) -> usize {
        let frames = samples.len() / CHANNELS as usize;
        let free = self.capacity - self.available();
        let take = frames.min(free);
        if take == 0 {
            return 0;
        }
        let write = self.write.load(Ordering::Relaxed) as usize;
        let index = write & self.mask;
        let first = take.min(self.capacity - index);
        // SAFETY: `take` frames fit before `write + capacity`, so neither copy
        // overlaps data the consumer may still be reading.
        unsafe {
            let data = &mut *self.data.get();
            let source = samples.as_ptr();
            ptr::copy_nonoverlapping(
                source,
                data.as_mut_ptr().add(index * CHANNELS as usize),
                first * CHANNELS as usize,
            );
            if first < take {
                ptr::copy_nonoverlapping(
                    source.add(first * CHANNELS as usize),
                    data.as_mut_ptr(),
                    (take - first) * CHANNELS as usize,
                );
            }
        }
        self.write.fetch_add(take as u64, Ordering::Release);
        take
    }

    /// Copies up to `out.len() / 2` frames and returns the frames copied.
    fn pull(&self, out: &mut [f32]) -> usize {
        let frames = out.len() / CHANNELS as usize;
        let available = self.available().min(frames);
        if available == 0 {
            return 0;
        }
        let read = self.read.load(Ordering::Relaxed) as usize;
        let index = read & self.mask;
        let first = available.min(self.capacity - index);
        // SAFETY: only frames below `write` are read, and the producer never
        // writes past `read + capacity`.
        unsafe {
            let data = &*self.data.get();
            ptr::copy_nonoverlapping(
                data.as_ptr().add(index * CHANNELS as usize),
                out.as_mut_ptr(),
                first * CHANNELS as usize,
            );
            if first < available {
                ptr::copy_nonoverlapping(
                    data.as_ptr(),
                    out.as_mut_ptr().add(first * CHANNELS as usize),
                    (available - first) * CHANNELS as usize,
                );
            }
        }
        self.read.fetch_add(available as u64, Ordering::Release);
        available
    }
}

struct OutputState {
    ring: Arc<Ring>,
    underruns: AtomicU64,
    silent_frames: AtomicU64,
    dropped_frames: AtomicU64,
    fatal: Mutex<Option<String>>,
}

pub struct OutputSession {
    state: Arc<OutputState>,
    stop: OwnedEvent,
    finished: Receiver<()>,
    thread: Option<JoinHandle<Result<(), String>>>,
}

impl OutputSession {
    pub fn open(device_name: Option<&str>, sample_rate: u32) -> Result<(Self, Opened), String> {
        let sample_rate = sample_rate.clamp(8_000, 192_000);
        let ring = Ring::new(sample_rate as usize * RING_SECONDS as usize);
        let stop = OwnedEvent::manual()?;
        let state = Arc::new(OutputState {
            ring,
            underruns: AtomicU64::new(0),
            silent_frames: AtomicU64::new(0),
            dropped_frames: AtomicU64::new(0),
            fatal: Mutex::new(None),
        });
        let (ready, started) = mpsc::sync_channel(1);
        let (finished, completion) = mpsc::channel();
        let thread_state = state.clone();
        let thread_stop = stop.0 .0 as usize;
        let requested = device_name.map(str::to_owned);
        let thread = thread::Builder::new()
            .name("clubify-output".into())
            .spawn(move || {
                let result = render_loop(
                    thread_state,
                    HANDLE(thread_stop as *mut c_void),
                    requested,
                    sample_rate,
                    ready,
                );
                let _ = finished.send(());
                result
            })
            .map_err(|error| format!("Failed to start the audio output thread: {error}"))?;
        let mut session = Self {
            state,
            stop,
            finished: completion,
            thread: Some(thread),
        };
        match started.recv_timeout(OPEN_TIMEOUT) {
            Ok(Ok(opened)) => Ok((session, opened)),
            Ok(Err(error)) => {
                session.stop();
                Err(error)
            }
            Err(_) => {
                session.stop();
                Err("Timed out opening the audio output".into())
            }
        }
    }

    /// Pushes interleaved stereo float32 frames. Returns dropped frames when
    /// the ring is full, which the engine treats as an overrun.
    pub fn push(&self, samples: &[f32]) -> usize {
        let frames = samples.len() / CHANNELS as usize;
        let taken = self.state.ring.push(samples);
        let dropped = frames - taken;
        if dropped > 0 {
            self.state
                .dropped_frames
                .fetch_add(dropped as u64, Ordering::Relaxed);
        }
        dropped
    }

    pub fn stats(&self) -> OutputStats {
        OutputStats {
            fill_frames: self.state.ring.available() as u64,
            capacity_frames: self.state.ring.capacity as u64,
            underruns: self.state.underruns.load(Ordering::Relaxed),
            silent_frames: self.state.silent_frames.load(Ordering::Relaxed),
            dropped_frames: self.state.dropped_frames.load(Ordering::Relaxed),
            fatal: self.state.fatal.lock().ok().and_then(|fatal| fatal.clone()),
        }
    }

    /// Clears counters, used when real audio starts so startup priming and
    /// capture switches do not look like playback dropouts.
    pub fn reset_stats(&self) {
        self.state.underruns.store(0, Ordering::Relaxed);
        self.state.silent_frames.store(0, Ordering::Relaxed);
        self.state.dropped_frames.store(0, Ordering::Relaxed);
    }

    pub fn stop(&mut self) {
        let _ = self.stop.signal();
        let finished = self.finished.recv_timeout(STOP_TIMEOUT);
        let Some(thread) = self.thread.take() else {
            return;
        };
        if finished.is_ok() {
            let _ = thread.join();
        } else {
            // A driver call is stuck; the thread owns its interfaces and the
            // ring stays valid because JS dropped this session's Arc handles.
            drop(thread);
        }
    }
}

impl Drop for OutputSession {
    fn drop(&mut self) {
        self.stop();
    }
}

fn render_loop(
    state: Arc<OutputState>,
    stop: HANDLE,
    requested: Option<String>,
    sample_rate: u32,
    ready: SyncSender<Result<Opened, String>>,
) -> Result<(), String> {
    let _apartment = ComScope::new()?;
    let initialized =
        (|| -> Result<(Opened, IAudioClient, IAudioRenderClient, OwnedEvent), String> {
            let enumerator = create_enumerator()?;
            let (device, device_name, warning) = pick_device(&enumerator, requested.as_deref())?;
            let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
                .map_err(|error| format!("Could not activate the output device: {error}"))?;
            let channels = CHANNELS;
            let block_align = channels * std::mem::size_of::<f32>() as u16;
            let format = WAVEFORMATEX {
                wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
                nChannels: channels,
                nSamplesPerSec: sample_rate,
                nAvgBytesPerSec: sample_rate * u32::from(block_align),
                nBlockAlign: block_align,
                wBitsPerSample: 32,
                cbSize: 0,
            };
            // SAFETY: the format lives through Initialize, which copies it. Shared
            // AUTOCONVERTPCM keeps the JS contract independent of the endpoint
            // format; the engine normally asks for the device's preferred rate.
            unsafe {
                client
                    .Initialize(
                        AUDCLNT_SHAREMODE_SHARED,
                        AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                            | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                            | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                        0,
                        0,
                        &format,
                        None,
                    )
                    .map_err(|error| format!("Could not initialize the output stream: {error}"))?;
            }
            let render: IAudioRenderClient =
                unsafe { client.GetService::<IAudioRenderClient>() }
                    .map_err(|error| format!("Could not get the render client: {error}"))?;
            let render_event = OwnedEvent::auto()?;
            unsafe { client.SetEventHandle(render_event.0) }
                .map_err(|error| format!("Could not attach the render event: {error}"))?;
            let period = unsafe { client.GetBufferSize() }
                .map_err(|error| format!("Could not read the render buffer size: {error}"))?;
            if period == 0 {
                return Err("The output device reported a zero-sized render buffer".into());
            }
            // Prime four periods so the first render callbacks never count a
            // startup underrun. Any excess above the JS target drains naturally
            // because the pump only tops the ring back up to the target.
            let prefill = vec![0.0f32; period as usize * CHANNELS as usize];
            for _ in 0..4 {
                state.ring.push(&prefill);
            }
            unsafe { client.Start() }
                .map_err(|error| format!("Could not start the output stream: {error}"))?;
            Ok((
                Opened {
                    device_name,
                    sample_rate,
                    period_frames: period,
                    warning,
                },
                client,
                render,
                render_event,
            ))
        })();
    let (opened, client, render, render_event) = match initialized {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    let _priority = AudioPriority::new();
    let period = opened.period_frames as usize;
    if ready.send(Ok(opened)).is_err() {
        unsafe {
            let _ = client.Stop();
        }
        return Ok(());
    }

    let mut scratch = vec![0.0f32; period * CHANNELS as usize];
    let mut result = Ok(());
    loop {
        let handles = [render_event.0, stop];
        // SAFETY: both handles are owned by this thread for the whole loop.
        let wait = unsafe { WaitForMultipleObjects(&handles, false, u32::MAX) };
        if wait.0 == WAIT_OBJECT_0.0 + 1 {
            break;
        }
        if wait != WAIT_OBJECT_0 {
            let message = if wait == WAIT_FAILED {
                "The output event wait failed".to_owned()
            } else if wait == WAIT_TIMEOUT {
                "The output event wait timed out".to_owned()
            } else {
                format!("The output event wait returned {wait:?}")
            };
            *state.fatal.lock().unwrap_or_else(|e| e.into_inner()) = Some(message.clone());
            result = Err(message);
            break;
        }
        let rendered = (|| -> Result<(), String> {
            let padding = unsafe { client.GetCurrentPadding() }
                .map_err(|error| format!("Could not read the render padding: {error}"))?;
            let free = period.saturating_sub(padding as usize);
            if free == 0 {
                return Ok(());
            }
            let target = &mut scratch[..free * CHANNELS as usize];
            let copied = state.ring.pull(target);
            if copied < free {
                state.underruns.fetch_add(1, Ordering::Relaxed);
                state
                    .silent_frames
                    .fetch_add((free - copied) as u64, Ordering::Relaxed);
                target[copied * CHANNELS as usize..].fill(0.0);
            }
            let buffer = unsafe { render.GetBuffer(free as u32) }
                .map_err(|error| format!("Could not get a render buffer: {error}"))?;
            if buffer.is_null() {
                return Err("The output device returned a null render buffer".into());
            }
            // SAFETY: the render client owns `free` frames until ReleaseBuffer.
            unsafe {
                ptr::copy_nonoverlapping(
                    target.as_ptr() as *const u8,
                    buffer,
                    free * CHANNELS as usize * std::mem::size_of::<f32>(),
                );
            }
            unsafe { render.ReleaseBuffer(free as u32, 0) }
                .map_err(|error| format!("Could not release the render buffer: {error}"))?;
            Ok(())
        })();
        if let Err(error) = rendered {
            *state.fatal.lock().unwrap_or_else(|e| e.into_inner()) = Some(error.clone());
            result = Err(error);
            break;
        }
    }
    unsafe {
        let _ = client.Stop();
    }
    result
}

/// Enumerates active render endpoints with their friendly name and mix format.
pub fn list_devices() -> Result<Vec<OutputDevice>, String> {
    let _apartment = ComScope::new()?;
    let enumerator = create_enumerator()?;
    let default_id = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .ok()
        .map(|device| device_id(&device));
    let collection: IMMDeviceCollection =
        unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
            .map_err(|error| format!("Could not enumerate output devices: {error}"))?;
    let count = unsafe { collection.GetCount() }
        .map_err(|error| format!("Could not count output devices: {error}"))?;
    let mut devices = Vec::new();
    for index in 0..count {
        let Ok(device) = (unsafe { collection.Item(index) }) else {
            continue;
        };
        let id = device_id(&device);
        let (channels, sample_rate) =
            match unsafe { device.Activate::<IAudioClient>(CLSCTX_ALL, None) } {
                Ok(client) => mix_format(&client).unwrap_or((CHANNELS, 48_000)),
                Err(_) => (CHANNELS, 48_000),
            };
        devices.push(OutputDevice {
            name: friendly_name(&device),
            is_default: default_id.as_deref() == Some(id.as_str()),
            channels,
            sample_rate,
        });
    }
    Ok(devices)
}

/// The device's preferred shared-mode rate, used as the engine rate so the
/// DSP runs at the rate the endpoint actually consumes.
pub fn preferred_rate(device_name: Option<&str>) -> Result<u32, String> {
    let _apartment = ComScope::new()?;
    let enumerator = create_enumerator()?;
    let (device, _, _) = pick_device(&enumerator, device_name)?;
    let client: IAudioClient = unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|error| format!("Could not activate the output device: {error}"))?;
    Ok(mix_format(&client)?.1)
}

fn create_enumerator() -> Result<IMMDeviceEnumerator, String> {
    unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .map_err(|error| format!("Could not create the audio device enumerator: {error}"))
}

fn pick_device(
    enumerator: &IMMDeviceEnumerator,
    requested: Option<&str>,
) -> Result<(IMMDevice, String, Option<String>), String> {
    let default = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }.ok();
    if let Some(name) = requested {
        if let Ok(collection) =
            unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }
        {
            if let Ok(count) = unsafe { collection.GetCount() } {
                for index in 0..count {
                    let Ok(device) = (unsafe { collection.Item(index) }) else {
                        continue;
                    };
                    let candidate = friendly_name(&device);
                    if candidate.eq_ignore_ascii_case(name) {
                        return Ok((device, candidate, None));
                    }
                }
            }
        }
        if let Some(device) = default {
            let candidate = friendly_name(&device);
            return Ok((
                device,
                candidate,
                Some(format!(
                    "Output device \"{name}\" was not found; using the system default"
                )),
            ));
        }
        return Err(format!("Output device \"{name}\" is not available"));
    }
    let device = default.ok_or_else(|| "No WASAPI output devices are available".to_owned())?;
    let name = friendly_name(&device);
    Ok((device, name, None))
}

fn mix_format(client: &IAudioClient) -> Result<(u16, u32), String> {
    let format = unsafe { client.GetMixFormat() }
        .map_err(|error| format!("Could not read the device mix format: {error}"))?;
    if format.is_null() {
        return Err("The device returned a null mix format".into());
    }
    let value = unsafe { *format };
    let result = (value.nChannels, value.nSamplesPerSec);
    unsafe { CoTaskMemFree(Some(format as *const c_void)) };
    Ok(result)
}

fn friendly_name(device: &IMMDevice) -> String {
    let store: Option<IPropertyStore> = unsafe { device.OpenPropertyStore(STGM_READ) }.ok();
    if let Some(store) = store {
        if let Ok(mut value) = unsafe { store.GetValue(&PKEY_Device_FriendlyName) } {
            let name = prop_string(&value);
            let _ = unsafe { PropVariantClear(&mut value) };
            if let Some(name) = name {
                return name;
            }
        }
    }
    device_id(device)
}

fn prop_string(value: &PROPVARIANT) -> Option<String> {
    // SAFETY: the union fields are valid for the `vt` discriminant; the store
    // only returns owned PROPVARIANTs that we clear after reading.
    let pointer: PWSTR = unsafe {
        if value.Anonymous.Anonymous.vt != VT_LPWSTR {
            return None;
        }
        value.Anonymous.Anonymous.Anonymous.pwszVal
    };
    if pointer.is_null() {
        return None;
    }
    unsafe { pointer.to_string() }.ok()
}

fn device_id(device: &IMMDevice) -> String {
    // SAFETY: the ID is a CoTaskMem allocation owned by us until freed.
    unsafe {
        match device.GetId() {
            Ok(id) => {
                let value = id.to_string().unwrap_or_default();
                CoTaskMemFree(Some(id.0 as *const c_void));
                value
            }
            Err(_) => String::new(),
        }
    }
}

fn describe(error: windows::core::Error) -> String {
    format!("WASAPI: {error}")
}

struct ComScope;

impl ComScope {
    fn new() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(describe)?;
        Ok(Self)
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        // SAFETY: balanced with a successful initialization on this thread.
        unsafe { CoUninitialize() };
    }
}

struct AudioPriority(HANDLE);

impl AudioPriority {
    fn new() -> Option<Self> {
        let mut task_index = 0;
        unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }
            .ok()
            .map(Self)
    }
}

impl Drop for AudioPriority {
    fn drop(&mut self) {
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

struct OwnedEvent(HANDLE);

impl OwnedEvent {
    fn create(manual: bool) -> Result<Self, String> {
        unsafe { CreateEventW(None, manual, false, PCWSTR::null()) }
            .map(Self)
            .map_err(|error| format!("Could not create an audio event: {error}"))
    }

    fn auto() -> Result<Self, String> {
        Self::create(false)
    }

    fn manual() -> Result<Self, String> {
        Self::create(true)
    }

    fn signal(&self) -> Result<(), String> {
        unsafe { SetEvent(self.0) }
            .map_err(|error| format!("Could not signal an audio event: {error}"))
    }
}

impl Drop for OwnedEvent {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

// Keep the unused import meaningful if the friendly-name property set changes.

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_wraps_and_reports_frames() {
        let ring = Ring::new(1024);
        let mut block = vec![0.0f32; 512 * CHANNELS as usize];
        for (index, sample) in block.iter_mut().enumerate() {
            *sample = index as f32;
        }
        assert_eq!(ring.push(&block), 512);
        assert_eq!(ring.available(), 512);
        let mut out = vec![0.0f32; 512 * CHANNELS as usize];
        assert_eq!(ring.pull(&mut out), 512);
        assert_eq!(out, block);
        assert_eq!(ring.available(), 0);
    }

    #[test]
    fn ring_drops_beyond_capacity() {
        let ring = Ring::new(1024);
        let block = vec![1.0f32; 800 * CHANNELS as usize];
        assert_eq!(ring.push(&block), 800);
        // Capacity is the next power of two >= 1024, so 800 + 800 overflows.
        assert_eq!(ring.push(&block), 224);
        assert_eq!(ring.available(), 1024);
    }

    #[test]
    fn ring_pull_wraps_around_the_end() {
        let ring = Ring::new(1024);
        let first = vec![1.0f32; 800 * CHANNELS as usize];
        ring.push(&first);
        let mut discard = vec![0.0f32; 700 * CHANNELS as usize];
        assert_eq!(ring.pull(&mut discard), 700);
        let second = vec![2.0f32; 200 * CHANNELS as usize];
        assert_eq!(ring.push(&second), 200);
        let mut out = vec![0.0f32; 300 * CHANNELS as usize];
        assert_eq!(ring.pull(&mut out), 300);
        assert!(out.iter().all(|sample| *sample >= 1.0));
    }
}
