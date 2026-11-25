//! Injects the Spotify tap DLL and reads its shared-memory audio ring.

use std::{
    collections::VecDeque,
    ffi::c_void,
    mem::size_of,
    os::windows::ffi::OsStrExt,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, TryRecvError},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use windows::{
    core::{s, w, PCWSTR},
    Win32::{
        Foundation::{CloseHandle, FreeLibrary, HANDLE, HMODULE, WAIT_OBJECT_0},
        System::{
            Diagnostics::{
                Debug::WriteProcessMemory,
                ToolHelp::{
                    CreateToolhelp32Snapshot, Module32FirstW, Module32NextW, MODULEENTRY32W,
                    TH32CS_SNAPMODULE, TH32CS_SNAPMODULE32,
                },
            },
            LibraryLoader::{GetModuleHandleW, GetProcAddress, LoadLibraryW},
            Memory::{
                MapViewOfFile, OpenFileMappingW, UnmapViewOfFile, VirtualAllocEx, VirtualFreeEx,
                FILE_MAP_ALL_ACCESS, MEM_COMMIT, MEM_RELEASE, MEM_RESERVE,
                MEMORY_MAPPED_VIEW_ADDRESS, PAGE_READWRITE,
            },
            Threading::{
                CreateRemoteThread, GetExitCodeThread, OpenProcess, WaitForSingleObject,
                LPTHREAD_START_ROUTINE, PROCESS_ALL_ACCESS,
            },
        },
    },
};

use crate::capture::{AudioSink, Session};

const MAGIC: u32 = 0x5054_5053; // "SPTP"
const VERSION: u32 = 1;
const HEADER_SIZE: usize = 64;
const MAX_CHUNK: usize = 64 * 1024;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const INJECT_TIMEOUT: u32 = 15_000;
const MEASURE_WARMUP: Duration = Duration::from_millis(150);
const MEASURE_WINDOW: Duration = Duration::from_millis(500);
const MEASURE_GAP: Duration = Duration::from_millis(100);
const RATE_TOLERANCE: f64 = 0.005;
const SINC_TAPS: i32 = 8;

#[derive(Clone, Copy, Debug)]
pub struct TapFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

#[repr(C)]
struct Header {
    magic: u32,
    version: u32,
    sample_rate: u32,
    channels: u32,
    frame_bytes: u32,
    format_tag: u32,
    channel_mask: u32,
    reserved1: u32,
    heartbeat_ms: AtomicU64,
    write_bytes: AtomicU64,
    read_bytes: AtomicU64,
    capacity: u64,
}

pub fn start_session(
    pid: u32,
    dll_path: &Path,
    expected_sample_rate: u32,
    sink: AudioSink,
) -> Result<(std::sync::Arc<Session>, TapFormat), String> {
    let dll_path = dll_path.to_path_buf();
    Session::start_worker_value(sink, move |sink, stop, ready| {
        run(
            pid,
            &dll_path,
            expected_sample_rate,
            sink,
            stop,
            ready,
        )
    })
}

fn run(
    pid: u32,
    dll_path: &Path,
    expected_sample_rate: u32,
    sink: AudioSink,
    stop: Receiver<()>,
    ready: SyncSender<Result<TapFormat, String>>,
) -> Result<(), String> {
    let startup = prepare(pid, dll_path, expected_sample_rate).and_then(|shared| {
        let format = shared.format;
        shared.begin()?;
        Ok((shared, format))
    });
    let (shared, format) = match startup {
        Ok(value) => value,
        Err(error) => {
            let _ = ready.send(Err(error.clone()));
            return Err(error);
        }
    };
    if ready.send(Ok(format)).is_err() {
        shared.end();
        return Ok(());
    }
    let result = read_loop(&shared, &sink, &stop, expected_sample_rate);
    shared.end();
    result
}

struct Shared {
    mapping: HANDLE,
    header: *mut Header,
    format: TapFormat,
}

// The reader worker is the only thread that touches the mapping.
unsafe impl Send for Shared {}

impl Shared {
    fn header(&self) -> &Header {
        // SAFETY: mapping lives for the whole Shared and is page-aligned.
        unsafe { &*self.header }
    }

    fn ring(&self) -> *mut u8 {
        // SAFETY: header occupies the first HEADER_SIZE bytes of the mapping.
        unsafe { (self.header as *mut u8).add(HEADER_SIZE) }
    }

    fn begin(&self) -> Result<(), String> {
        let header = self.header();
        header.heartbeat_ms.store(now_ms(), Ordering::Release);
        let write = header.write_bytes.load(Ordering::Acquire);
        header.read_bytes.store(write, Ordering::Release);
        Ok(())
    }

    fn end(&self) {
        self.header()
            .heartbeat_ms
            .store(0, Ordering::Release);
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        self.end();
        let _ = unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: self.header as *mut c_void,
            })
        };
        let _ = unsafe { CloseHandle(self.mapping) };
    }
}

fn prepare(pid: u32, dll_path: &Path, expected_sample_rate: u32) -> Result<Shared, String> {
    inject(pid, dll_path)?;
    let mapping = open_mapping(pid)?;
    let view = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0) };
    if view.Value.is_null() {
        let _ = unsafe { CloseHandle(mapping) };
        return Err("Could not map the Spotify tap shared memory".into());
    }
    let header = view.Value as *mut Header;
    // SAFETY: fields are written by StartTap before the mapping is opened by us.
    let (magic, version, sample_rate, channels, frame_bytes, format_tag, _channel_mask, capacity) =
        unsafe {
            (
                (*header).magic,
                (*header).version,
                (*header).sample_rate,
                (*header).channels,
                (*header).frame_bytes,
                (*header).format_tag,
                (*header).channel_mask,
                (*header).capacity,
            )
        };
    let valid = magic == MAGIC
        && version >= VERSION
        && sample_rate >= 8_000
        && sample_rate <= 192_000
        && channels == 2
        && frame_bytes == 8
        && format_tag == 3
        && capacity >= MAX_CHUNK as u64;
    if !valid {
        let _ = unsafe {
            UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS {
                Value: view.Value,
            })
        };
        let _ = unsafe { CloseHandle(mapping) };
        return Err(format!(
            "Spotify tap reported an unsupported format ({channels} ch, {frame_bytes} bytes/frame, {format_tag}, {sample_rate} Hz)"
        ));
    }
    Ok(Shared {
        mapping,
        header,
        format: TapFormat {
            // The endpoint mix rate is not necessarily Spotify's render rate;
            // read_loop measures the real rate and resamples to the engine rate.
            sample_rate: expected_sample_rate,
            channels: 2,
        },
    })
}

fn read_loop(
    shared: &Shared,
    sink: &AudioSink,
    stop: &Receiver<()>,
    expected_rate: u32,
) -> Result<(), String> {
    let header = shared.header();
    let ring = shared.ring();
    let capacity = header.capacity as usize;
    let mut read = header.read_bytes.load(Ordering::Acquire);
    let mut flow = Flow::Measuring {
        first_packet: None,
        started: None,
        last_packet: None,
        frames: 0,
    };
    while sink.active() && matches!(stop.try_recv(), Err(TryRecvError::Empty)) {
        header.heartbeat_ms.store(now_ms(), Ordering::Release);
        let write = header.write_bytes.load(Ordering::Acquire);
        if write > read {
            let mut available = write - read;
            if available > capacity as u64 {
                read = write - capacity as u64;
                available = capacity as u64;
            }
            while available > 0 && sink.active() {
                let take = available.min(MAX_CHUNK as u64) as usize;
                let offset = (read % capacity as u64) as usize;
                let first = take.min(capacity - offset);
                let mut packet = Vec::with_capacity(take);
                // SAFETY: the producer only overwrites bytes below write_bytes,
                // and the ring capacity is never exceeded.
                unsafe {
                    packet.extend_from_slice(std::slice::from_raw_parts(ring.add(offset), first));
                    if first < take {
                        packet.extend_from_slice(std::slice::from_raw_parts(ring, take - first));
                    }
                }
                read += take as u64;
                header.read_bytes.store(read, Ordering::Release);
                available -= take as u64;
                if !handle_packet(&mut flow, packet, expected_rate, sink) {
                    return Ok(());
                }
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    Ok(())
}

enum Flow {
    Measuring {
        first_packet: Option<Instant>,
        started: Option<Instant>,
        last_packet: Option<Instant>,
        frames: u64,
    },
    Passthrough,
    Resampling(Resampler),
}

/// Spotify's render buffer is commonly 44.1 kHz even when the endpoint mix
/// format is 48 kHz. Measuring the delivered frames lets us detect that and
/// resample to the engine rate instead of starving its playback queue.
fn handle_packet(
    flow: &mut Flow,
    packet: Vec<u8>,
    expected_rate: u32,
    sink: &AudioSink,
) -> bool {
    match flow {
        Flow::Measuring {
            first_packet,
            started,
            last_packet,
            frames,
        } => {
            let packet_frames = packet.len() / 8;
            if packet_frames == 0 {
                return true;
            }
            let now = Instant::now();
            if last_packet.is_some_and(|last| now.duration_since(last) > MEASURE_GAP) {
                *first_packet = Some(now);
                *started = None;
                *frames = 0;
            }
            let first = *first_packet.get_or_insert(now);
            *last_packet = Some(now);
            match *started {
                None => {
                    // Skip Spotify's initial buffered burst before measuring.
                    if now.duration_since(first) >= MEASURE_WARMUP {
                        *started = Some(now);
                        *frames = 0;
                    }
                }
                Some(start) => {
                    *frames += packet_frames as u64;
                    let elapsed = now.duration_since(start);
                    if elapsed >= MEASURE_WINDOW {
                        let measured = *frames as f64 / elapsed.as_secs_f64().max(1e-6);
                        if measured < expected_rate as f64 * 0.5
                            || measured > expected_rate as f64 * 2.0
                        {
                            *started = None;
                            *frames = 0;
                            return true;
                        }
                        let rate = snap_rate(measured, measured);
                        let error = (rate - expected_rate as f64).abs() / expected_rate as f64;
                        *flow = if error <= RATE_TOLERANCE {
                            Flow::Passthrough
                        } else {
                            Flow::Resampling(Resampler::new(rate, expected_rate as f64))
                        };
                    }
                }
            }
            // Measurement packets are intentionally discarded; they also give
            // the resampler a clean starting point.
            true
        }
        Flow::Passthrough => {
            if !sane_pcm(&packet) {
                return true;
            }
            sink.emit(packet)
        }
        Flow::Resampling(resampler) => {
            let mut output = Vec::with_capacity(packet.len() + packet.len() / 8);
            resampler.push(&packet, &mut output);
            if output.is_empty() || !sane_pcm(&output) {
                return true;
            }
            sink.emit(output)
        }
    }
}

fn sane_pcm(packet: &[u8]) -> bool {
    packet.chunks_exact(4).all(|bytes| {
        let value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        value.is_finite() && value.abs() <= 8.0
    })
}

struct Resampler {
    step: f64,
    position: f64,
    left: VecDeque<f32>,
    right: VecDeque<f32>,
}

impl Resampler {
    fn new(src_rate: f64, dst_rate: f64) -> Self {
        Self {
            step: src_rate / dst_rate,
            position: SINC_TAPS as f64,
            left: VecDeque::new(),
            right: VecDeque::new(),
        }
    }

    fn push(&mut self, input: &[u8], output: &mut Vec<u8>) {
        for frame in input.chunks_exact(8) {
            self.left.push_back(f32::from_le_bytes([
                frame[0], frame[1], frame[2], frame[3],
            ]));
            self.right.push_back(f32::from_le_bytes([
                frame[4], frame[5], frame[6], frame[7],
            ]));
        }
        loop {
            let center = self.position.floor() as isize;
            if center + SINC_TAPS as isize >= self.left.len() as isize {
                break;
            }
            let mut left = 0.0f64;
            let mut right = 0.0f64;
            let mut weight_sum = 0.0f64;
            for tap in (-SINC_TAPS + 1)..=SINC_TAPS {
                let index = center + tap as isize;
                if index < 0 || index >= self.left.len() as isize {
                    continue;
                }
                let distance = self.position - index as f64;
                if distance.abs() >= SINC_TAPS as f64 {
                    continue;
                }
                let weight = sinc(distance) * blackman(distance / SINC_TAPS as f64);
                left += self.left[index as usize] as f64 * weight;
                right += self.right[index as usize] as f64 * weight;
                weight_sum += weight;
            }
            if weight_sum.abs() > 1e-9 {
                left /= weight_sum;
                right /= weight_sum;
            }
            output.extend_from_slice(&(left as f32).to_le_bytes());
            output.extend_from_slice(&(right as f32).to_le_bytes());
            self.position += self.step;
            let drop = (self.position.floor() as usize)
                .saturating_sub(SINC_TAPS as usize)
                .min(self.left.len());
            if drop > 0 {
                self.left.drain(..drop);
                self.right.drain(..drop);
                self.position -= drop as f64;
            }
        }
    }
}

fn sinc(value: f64) -> f64 {
    if value.abs() < 1e-9 {
        1.0
    } else {
        let angle = std::f64::consts::PI * value;
        angle.sin() / angle
    }
}

fn blackman(value: f64) -> f64 {
    let angle = std::f64::consts::PI * value;
    0.42 + 0.5 * angle.cos() + 0.08 * (2.0 * angle).cos()
}

fn snap_rate(measured: f64, fallback: f64) -> f64 {
    const COMMON: [f64; 8] = [
        22_050.0, 32_000.0, 44_100.0, 48_000.0, 88_200.0, 96_000.0, 176_400.0, 192_000.0,
    ];
    COMMON
        .iter()
        .copied()
        .filter(|rate| (rate - measured).abs() / rate < 0.02)
        .min_by(|left, right| {
            (left - measured)
                .abs()
                .partial_cmp(&(right - measured).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(fallback)
}

/// Asks a loaded tap DLL to restore the original render vtable. Safe to call
/// when the module is already gone (for example after Spotify restarted).
pub fn stop(pid: u32, dll_path: &Path) -> Result<(), String> {
    let file_name = dll_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Spotify tap DLL path has no file name".to_owned())?;
    if module_base(pid, file_name).is_none() {
        return Ok(());
    }
    let path_wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let process = OwnedHandle(unsafe { OpenProcess(PROCESS_ALL_ACCESS, false, pid) }
        .map_err(|error| format!("Could not open Spotify (PID {pid}): {error}"))?);
    let _ = call_export(process.0, pid, file_name, &path_wide, "StopTap")?;
    Ok(())
}

fn inject(pid: u32, dll_path: &Path) -> Result<(), String> {
    let file_name = dll_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Spotify tap DLL path has no file name".to_owned())?;
    let path_wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let process = OwnedHandle(unsafe { OpenProcess(PROCESS_ALL_ACCESS, false, pid) }
        .map_err(|error| format!("Could not open Spotify (PID {pid}): {error}"))?);

    if module_base(pid, file_name).is_none() {
        load_remote(process.0, &path_wide)?;
        wait_for_module(pid, file_name)?;
    }

    let code = call_export(process.0, pid, file_name, &path_wide, "StartTap")?;
    if code != 0 {
        return Err(format!("Spotify tap setup failed with code {code}"));
    }
    Ok(())
}

fn call_export(
    process: HANDLE,
    pid: u32,
    file_name: &str,
    path_wide: &[u16],
    export: &str,
) -> Result<u32, String> {
    let local = LocalModule(
        unsafe { LoadLibraryW(PCWSTR(path_wide.as_ptr())) }
            .map_err(|error| format!("Could not load the tap DLL locally: {error}"))?,
    );
    let entry = match export {
        "StartTap" => unsafe { GetProcAddress(local.0, s!("StartTap")) },
        "StopTap" => unsafe { GetProcAddress(local.0, s!("StopTap")) },
        _ => None,
    }
    .ok_or_else(|| format!("The tap DLL does not export {export}"))?;
    let remote_base = module_base(pid, file_name)
        .ok_or_else(|| "The tap DLL did not stay loaded in Spotify".to_owned())?;
    let local_base = local.0 .0 as usize;
    let offset = entry as usize - local_base;
    let remote_start = remote_base + offset;
    let thread = OwnedHandle(unsafe {
        CreateRemoteThread(
            process,
            None,
            0,
            std::mem::transmute::<usize, LPTHREAD_START_ROUTINE>(remote_start),
            None,
            0,
            None,
        )
    }
    .map_err(|error| format!("Could not call {export} in Spotify: {error}"))?);
    wait_for_thread(thread.0, export)?;
    let mut code = 0u32;
    let _ = unsafe { GetExitCodeThread(thread.0, &mut code) };
    Ok(code)
}

fn load_remote(process: HANDLE, path_wide: &[u16]) -> Result<(), String> {
    let size = path_wide.len() * size_of::<u16>();
    let remote = RemoteMemory {
        process,
        address: unsafe {
            VirtualAllocEx(
                process,
                None,
                size,
                MEM_COMMIT | MEM_RESERVE,
                PAGE_READWRITE,
            )
        },
    };
    if remote.address.is_null() {
        return Err("Could not allocate memory in Spotify".into());
    }
    unsafe {
        WriteProcessMemory(
            process,
            remote.address as *const c_void,
            path_wide.as_ptr() as *const c_void,
            size,
            None,
        )
    }
    .map_err(|error| format!("Could not write the tap DLL path into Spotify: {error}"))?;
    let load_library = unsafe { GetProcAddress(kernel32()?, s!("LoadLibraryW")) }
        .ok_or_else(|| "Could not resolve LoadLibraryW".to_owned())?;
    let thread = OwnedHandle(unsafe {
        CreateRemoteThread(
            process,
            None,
            0,
            std::mem::transmute::<usize, LPTHREAD_START_ROUTINE>(load_library as usize),
            Some(remote.address as *const c_void),
            0,
            None,
        )
    }
    .map_err(|error| format!("Could not load the tap DLL in Spotify: {error}"))?);
    wait_for_thread(thread.0, "tap DLL load")?;
    Ok(())
}

fn wait_for_module(pid: u32, file_name: &str) -> Result<(), String> {
    for _ in 0..50 {
        if module_base(pid, file_name).is_some() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err("The tap DLL did not appear in Spotify after loading".into())
}

fn wait_for_thread(thread: HANDLE, operation: &str) -> Result<(), String> {
    let result = unsafe { WaitForSingleObject(thread, INJECT_TIMEOUT) };
    if result == WAIT_OBJECT_0 {
        Ok(())
    } else {
        Err(format!("Timed out during {operation} (wait result {result:?})"))
    }
}

fn kernel32() -> Result<HMODULE, String> {
    unsafe { GetModuleHandleW(w!("kernel32.dll")) }
        .map_err(|error| format!("Could not resolve kernel32.dll: {error}"))
}

fn module_base(pid: u32, file_name: &str) -> Option<usize> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) }.ok()?;
    let mut entry = MODULEENTRY32W {
        dwSize: size_of::<MODULEENTRY32W>() as u32,
        ..Default::default()
    };
    let mut base = None;
    if unsafe { Module32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            let name = utf16_z(&entry.szModule);
            if name.eq_ignore_ascii_case(file_name) {
                base = Some(entry.modBaseAddr as usize);
                break;
            }
            if unsafe { Module32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    let _ = unsafe { CloseHandle(snapshot) };
    base
}

fn open_mapping(pid: u32) -> Result<HANDLE, String> {
    let name = mapping_name(pid);
    for _ in 0..50 {
        if let Ok(mapping) =
            unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(name.as_ptr())) }
        {
            return Ok(mapping);
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err("Could not open the Spotify tap shared memory".into())
}

fn mapping_name(pid: u32) -> Vec<u16> {
    format!("Local\\SpotifyTap_{pid}_v1")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect()
}

fn utf16_z(value: &[u16]) -> String {
    let end = value.iter().position(|unit| *unit == 0).unwrap_or(value.len());
    String::from_utf16_lossy(&value[..end])
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct OwnedHandle(HANDLE);
impl Drop for OwnedHandle {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct LocalModule(HMODULE);
impl Drop for LocalModule {
    fn drop(&mut self) {
        let _ = unsafe { FreeLibrary(self.0) };
    }
}

struct RemoteMemory {
    process: HANDLE,
    address: *mut c_void,
}

impl Drop for RemoteMemory {
    fn drop(&mut self) {
        if !self.address.is_null() {
            let _ = unsafe { VirtualFreeEx(self.process, self.address, 0, MEM_RELEASE) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resampler_produces_destination_rate_frames() {
        let mut resampler = Resampler::new(44_100.0, 48_000.0);
        let frames = 44_100usize;
        let mut input = Vec::with_capacity(frames * 8);
        for index in 0..frames {
            let value = ((index as f32) * 0.05).sin() * 0.5;
            input.extend_from_slice(&value.to_le_bytes());
            input.extend_from_slice(&value.to_le_bytes());
        }
        let mut output = Vec::new();
        for chunk in input.chunks(441 * 8) {
            resampler.push(chunk, &mut output);
        }
        let output_frames = output.len() / 8;
        assert!(
            (output_frames as f64 - 48_000.0).abs() < 100.0,
            "output frames: {output_frames}"
        );
    }

    #[test]
    fn snaps_measured_rate_to_common_clock() {
        assert_eq!(snap_rate(44_095.5, 48_000.0), 44_100.0);
        assert_eq!(snap_rate(47_990.0, 48_000.0), 48_000.0);
    }

    #[test]
    fn rejects_non_finite_and_extreme_pcm() {
        let mut non_finite = Vec::new();
        non_finite.extend_from_slice(&f32::NAN.to_le_bytes());
        non_finite.extend_from_slice(&0.0f32.to_le_bytes());
        assert!(!sane_pcm(&non_finite));
        let mut normal = Vec::new();
        normal.extend_from_slice(&0.5f32.to_le_bytes());
        normal.extend_from_slice(&0.5f32.to_le_bytes());
        assert!(sane_pcm(&normal));
    }
}