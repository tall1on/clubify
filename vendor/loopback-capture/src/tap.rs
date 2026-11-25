//! Injects the Spotify tap DLL and reads its shared-memory audio ring.
//!
//! The reader wakes on the DLL's named event instead of polling, measures
//! Spotify's real render rate from the header's `(write_bytes, qpc)` pair, and
//! resamples with a polyphase Kaiser kernel when the render rate differs from
//! the engine rate. Header version 1 (an older injected DLL) still works with
//! poll-based timing.

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
                FILE_MAP_ALL_ACCESS, MEMORY_MAPPED_VIEW_ADDRESS, MEM_COMMIT, MEM_RELEASE,
                MEM_RESERVE, PAGE_READWRITE,
            },
            Performance::QueryPerformanceFrequency,
            Threading::{
                AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW, CreateRemoteThread,
                GetExitCodeThread, OpenEventW, OpenProcess, WaitForSingleObject,
                LPTHREAD_START_ROUTINE, PROCESS_ALL_ACCESS, SYNCHRONIZATION_ACCESS_RIGHTS,
            },
        },
    },
};

use crate::capture::{AudioSink, Session};

const MAGIC: u32 = 0x5054_5053; // "SPTP"
const VERSION_V1: u32 = 1;
const VERSION_V2: u32 = 2;
const HEADER_SIZE_V1: usize = 64;
const HEADER_SIZE_V2: usize = 128;
const MAX_CHUNK: usize = 64 * 1024;
const EVENT_TIMEOUT_MS: u32 = 20;
const POLL_INTERVAL: Duration = Duration::from_millis(5);
const MEASURE_GAP: Duration = Duration::from_millis(300);
const MEASURE_SPAN: Duration = Duration::from_millis(400);
const LEGACY_MEASURE_SPAN: Duration = Duration::from_millis(1200);
const REPLAY_BUFFER_MS: u64 = 64;
const RATE_SNAP_TOLERANCE: f64 = 0.015;
const RATE_SWITCH_TOLERANCE: f64 = 0.005;
const PASSTHROUGH_TOLERANCE: f64 = 0.001;
const INJECT_TIMEOUT: u32 = 15_000;
const ERR_OTHER_OWNER: u32 = 20;
const RESAMPLE_TAPS: usize = 64;
const RESAMPLE_HALF: usize = RESAMPLE_TAPS / 2;
const RESAMPLE_PHASES: usize = 512;
const RESAMPLE_CUTOFF: f64 = 0.95;
const KAISER_BETA: f64 = 8.6;

#[derive(Clone, Copy, Debug)]
pub struct TapFormat {
    pub sample_rate: u32,
    pub channels: u16,
}

/// Header version 2. The first 64 bytes match version 1 byte for byte, so a
/// reader can inspect `version`/`capacity` before choosing its ring offset.
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
    seq: AtomicU64,
    qpc: AtomicU64,
    dropped_bytes: AtomicU64,
    _reserved: [u64; 5],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartOutcome {
    /// This DLL generation owns the hook and publishes the version 2 mapping.
    Owner,
    /// An older installed DLL owns the hook; read its version 1 mapping.
    OtherOwner,
}

pub fn start_session(
    pid: u32,
    dll_path: &Path,
    expected_sample_rate: u32,
    sink: AudioSink,
) -> Result<(std::sync::Arc<Session>, TapFormat), String> {
    let dll_path = dll_path.to_path_buf();
    Session::start_worker_value(sink, move |sink, stop, ready| {
        run(pid, &dll_path, expected_sample_rate, sink, stop, ready)
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
    version: u32,
    header_size: usize,
    event: Option<OwnedHandle>,
    qpc_frequency: u64,
}

// The reader worker is the only thread that touches the mapping.
unsafe impl Send for Shared {}

impl Shared {
    fn header(&self) -> &Header {
        // SAFETY: mapping lives for the whole Shared and is page-aligned.
        unsafe { &*self.header }
    }

    fn capacity(&self) -> usize {
        self.header().capacity as usize
    }

    fn ring(&self) -> *mut u8 {
        // SAFETY: the header occupies the first `header_size` bytes and the
        // mapping always covers header plus ring (both versions).
        unsafe { (self.header as *mut u8).add(self.header_size) }
    }

    fn heartbeat(&self) {
        self.header()
            .heartbeat_ms
            .store(now_ms(), Ordering::Release);
    }

    fn read_position(&self) -> u64 {
        self.header().read_bytes.load(Ordering::Acquire)
    }

    fn store_read_position(&self, value: u64) {
        self.header().read_bytes.store(value, Ordering::Release);
    }

    fn write_position(&self) -> u64 {
        self.header().write_bytes.load(Ordering::Acquire)
    }

    /// A consistent `(write_bytes, qpc)` sample. The DLL bumps a seqlock
    /// around the pair so the rate calculation is not skewed by tearing.
    fn sample_pair(&self) -> Option<(u64, u64)> {
        if self.version < VERSION_V2 {
            return None;
        }
        let header = self.header();
        for _ in 0..16 {
            let first = header.seq.load(Ordering::Acquire);
            if first == 0 || first & 1 != 0 {
                continue;
            }
            let qpc = header.qpc.load(Ordering::Relaxed);
            let bytes = header.write_bytes.load(Ordering::Acquire);
            let second = header.seq.load(Ordering::Acquire);
            if first == second {
                return Some((bytes, qpc));
            }
        }
        None
    }

    fn dropped_bytes(&self) -> u64 {
        if self.version < VERSION_V2 {
            return 0;
        }
        self.header().dropped_bytes.load(Ordering::Relaxed)
    }

    fn begin(&self) -> Result<(), String> {
        self.heartbeat();
        let write = self.write_position();
        self.store_read_position(write);
        Ok(())
    }

    fn end(&self) {
        self.header().heartbeat_ms.store(0, Ordering::Release);
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
    let mut outcome = inject(pid, dll_path)?;
    if outcome == StartOutcome::OtherOwner {
        // An older tap DLL owns the process. Its watchdog restores the render
        // vtable within a few seconds once no consumer heartbeat is present, so
        // retry briefly; taking over avoids restarting Spotify after an update.
        for _ in 0..8 {
            thread::sleep(Duration::from_millis(400));
            outcome = inject(pid, dll_path)?;
            if outcome == StartOutcome::Owner {
                break;
            }
        }
    }
    let (mapping_name, wants_event) = match outcome {
        StartOutcome::Owner => (format!("Local\\SpotifyTap_{pid}_v2"), true),
        // An older DLL still owns the hook; read its version 1 mapping instead
        // of writing a version 2 header into a smaller section.
        StartOutcome::OtherOwner => (format!("Local\\SpotifyTap_{pid}_v1"), false),
    };
    let mapping = open_mapping(&mapping_name)?;
    let view = unsafe { MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0) };
    if view.Value.is_null() {
        let _ = unsafe { CloseHandle(mapping) };
        return Err("Could not map the Spotify tap shared memory".into());
    }
    let header = view.Value as *mut Header;
    // SAFETY: fields are written by StartTap before the mapping is opened by us.
    let (magic, version, channels, frame_bytes, format_tag, capacity) = unsafe {
        (
            (*header).magic,
            (*header).version,
            (*header).channels,
            (*header).frame_bytes,
            (*header).format_tag,
            (*header).capacity,
        )
    };
    let header_size = match version {
        VERSION_V2.. => HEADER_SIZE_V2,
        VERSION_V1 => HEADER_SIZE_V1,
        _ => 0,
    };
    let owner_matches = match outcome {
        StartOutcome::Owner => version >= VERSION_V2,
        StartOutcome::OtherOwner => version == VERSION_V1,
    };
    let valid = owner_matches
        && magic == MAGIC
        && header_size != 0
        && channels == 2
        && frame_bytes == 8
        && format_tag == 3
        && capacity >= MAX_CHUNK as u64;
    if !valid {
        let _ = unsafe { UnmapViewOfFile(MEMORY_MAPPED_VIEW_ADDRESS { Value: view.Value }) };
        let _ = unsafe { CloseHandle(mapping) };
        return Err(format!(
            "Spotify tap reported an unsupported format ({channels} ch, {frame_bytes} bytes/frame, {format_tag}, version {version})"
        ));
    }
    let event = if wants_event { open_event(pid) } else { None };
    Ok(Shared {
        mapping,
        header,
        format: TapFormat {
            // The endpoint mix rate is not necessarily Spotify's render rate;
            // read_loop measures the real rate and resamples to the engine rate.
            sample_rate: expected_sample_rate,
            channels: 2,
        },
        version,
        header_size,
        event,
        qpc_frequency: qpc_frequency(),
    })
}

fn read_loop(
    shared: &Shared,
    sink: &AudioSink,
    stop: &Receiver<()>,
    expected_rate: u32,
) -> Result<(), String> {
    let _priority = AudioPriority::new();
    let capacity = shared.capacity();
    let mut read = shared.read_position();
    let mut probe = RateProbe::new(
        expected_rate,
        shared.qpc_frequency,
        shared.version >= VERSION_V2,
    );
    let mut flow = Flow::Measuring;
    let mut flow_rate = expected_rate as f64;
    let mut last_packet: Option<Instant> = None;
    let mut dropped_seen = 0u64;
    while sink.active() && matches!(stop.try_recv(), Err(TryRecvError::Empty)) {
        shared.heartbeat();

        let dropped = shared.dropped_bytes();
        if dropped > dropped_seen {
            sink.note_dropped((dropped - dropped_seen) as usize);
            dropped_seen = dropped;
        }

        let write = shared.write_position();
        if write > read {
            let mut available = write - read;
            if available > capacity as u64 {
                let skipped = available - capacity as u64;
                sink.note_dropped(skipped as usize);
                read = write - capacity as u64;
                available = capacity as u64;
                probe.restart();
            }
            let now = Instant::now();
            if last_packet.is_some_and(|last| now.duration_since(last) > MEASURE_GAP) {
                // Spotify paused, restarted its stream, or changed device.
                // Keep the measured rate so playback resumes without another
                // full measurement window; a background probe re-checks it.
                probe.restart();
                if let Flow::Resampling(resampler) = &mut flow {
                    resampler.reset();
                }
            }
            if shared.version >= VERSION_V2 {
                if let Some((bytes, qpc)) = shared.sample_pair() {
                    probe.observe_qpc(bytes, qpc, now);
                }
            } else {
                probe.observe_wall(write, now);
            }
            while available > 0 && sink.active() {
                let take = available.min(MAX_CHUNK as u64) as usize;
                let offset = (read % capacity as u64) as usize;
                let first = take.min(capacity - offset);
                let mut packet = Vec::with_capacity(take);
                // SAFETY: the producer only overwrites bytes below write_bytes,
                // and the ring capacity is never exceeded.
                unsafe {
                    packet
                        .extend_from_slice(std::slice::from_raw_parts(ring(shared, offset), first));
                    if first < take {
                        packet.extend_from_slice(std::slice::from_raw_parts(
                            shared.ring(),
                            take - first,
                        ));
                    }
                }
                read += take as u64;
                shared.store_read_position(read);
                available -= take as u64;
                last_packet = Some(Instant::now());
                if matches!(flow, Flow::Measuring) {
                    probe.buffer(packet, sink);
                } else if !deliver(&mut flow, packet, sink) {
                    return Ok(());
                }
            }
        }

        if let Some(rate) = probe.decide() {
            match flow {
                Flow::Measuring => {
                    let buffered = probe.take();
                    flow = choose_flow(rate, expected_rate);
                    flow_rate = rate;
                    for packet in buffered {
                        if !deliver(&mut flow, packet, sink) {
                            return Ok(());
                        }
                    }
                }
                _ => {
                    // Steady-state background probe: only re-plan when the
                    // render rate actually moved (for example a device switch).
                    if (rate - flow_rate).abs() / flow_rate.max(1.0) > RATE_SWITCH_TOLERANCE {
                        flow = choose_flow(rate, expected_rate);
                        flow_rate = rate;
                    }
                    probe.restart();
                }
            }
        }

        match &shared.event {
            Some(event) => {
                // SAFETY: the handle is owned by Shared and lives past the wait.
                unsafe { WaitForSingleObject(event.0, EVENT_TIMEOUT_MS) };
            }
            None => thread::sleep(POLL_INTERVAL),
        }
    }
    Ok(())
}

/// No audio interface is transferred between threads, but a worker registered
/// as an audio task is scheduled ahead of normal Node work.
struct AudioPriority(HANDLE);

impl AudioPriority {
    fn new() -> Option<Self> {
        let mut task_index = 0;
        // SAFETY: registers only this reader thread; scheduler failure is non-fatal.
        unsafe { AvSetMmThreadCharacteristicsW(w!("Audio"), &mut task_index) }
            .ok()
            .map(Self)
    }
}

impl Drop for AudioPriority {
    fn drop(&mut self) {
        // SAFETY: balanced on the thread that registered this MMCSS task.
        let _ = unsafe { AvRevertMmThreadCharacteristics(self.0) };
    }
}

enum Flow {
    Measuring,
    Passthrough,
    Resampling(Resampler),
}

fn deliver(flow: &mut Flow, mut packet: Vec<u8>, sink: &AudioSink) -> bool {
    sanitize_pcm(&mut packet);
    match flow {
        Flow::Passthrough => sink.emit(packet),
        Flow::Resampling(resampler) => {
            let mut output = Vec::with_capacity(packet.len() + packet.len() / 8);
            resampler.push(&packet, &mut output);
            if output.is_empty() {
                true
            } else {
                sink.emit(output)
            }
        }
        Flow::Measuring => true,
    }
}

fn choose_flow(rate: f64, expected_rate: u32) -> Flow {
    let error = (rate - expected_rate as f64).abs() / expected_rate as f64;
    if error <= PASSTHROUGH_TOLERANCE {
        Flow::Passthrough
    } else {
        Flow::Resampling(Resampler::new(rate, expected_rate as f64))
    }
}

/// Replaces non-finite or absurd samples with silence instead of dropping a
/// whole packet, which would splice a time gap into the stream.
fn sanitize_pcm(packet: &mut [u8]) {
    for bytes in packet.chunks_exact_mut(4) {
        let value = f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]);
        if !value.is_finite() || value.abs() > 8.0 {
            bytes.copy_from_slice(&0.0f32.to_le_bytes());
        }
    }
}

#[derive(Clone, Copy)]
struct RateSample {
    bytes: u64,
    ticks: u64,
    wall: Instant,
}

/// Measures the producer rate from exactly paired `(write_bytes, qpc)` samples.
/// Audio is buffered while measuring and flushed once the rate is known, so a
/// start or device switch no longer discards the first second of playback.
struct RateProbe {
    expected_rate: u32,
    qpc_frequency: u64,
    use_qpc: bool,
    start: Option<RateSample>,
    last: Option<RateSample>,
    buffered: VecDeque<Vec<u8>>,
    buffered_bytes: usize,
    max_buffered_bytes: usize,
}

impl RateProbe {
    fn new(expected_rate: u32, qpc_frequency: u64, use_qpc: bool) -> Self {
        let use_qpc = use_qpc && qpc_frequency > 0;
        Self {
            expected_rate,
            qpc_frequency,
            use_qpc,
            start: None,
            last: None,
            buffered: VecDeque::new(),
            buffered_bytes: 0,
            max_buffered_bytes: (expected_rate as u64 * 8 * REPLAY_BUFFER_MS / 1_000) as usize,
        }
    }

    fn restart(&mut self) {
        self.start = None;
        self.last = None;
        self.buffered.clear();
        self.buffered_bytes = 0;
    }

    fn observe_qpc(&mut self, bytes: u64, qpc: u64, wall: Instant) {
        let sample = RateSample {
            bytes,
            ticks: qpc,
            wall,
        };
        self.observe(sample);
    }

    fn observe_wall(&mut self, bytes: u64, wall: Instant) {
        let sample = RateSample {
            bytes,
            ticks: 0,
            wall,
        };
        self.observe(sample);
    }

    fn observe(&mut self, sample: RateSample) {
        if self.start.is_none() {
            self.start = Some(sample);
        }
        self.last = Some(sample);
    }

    fn span(&self) -> Duration {
        if self.use_qpc {
            MEASURE_SPAN
        } else {
            LEGACY_MEASURE_SPAN
        }
    }

    /// Frames per second, or `None` while still measuring.
    fn decide(&mut self) -> Option<f64> {
        let start = self.start?;
        let last = self.last?;
        let bytes = last.bytes.checked_sub(start.bytes)?;
        if bytes == 0 {
            return None;
        }
        let seconds = if self.use_qpc {
            let ticks = last.ticks.checked_sub(start.ticks)?;
            if ticks == 0 {
                return None;
            }
            ticks as f64 / self.qpc_frequency as f64
        } else {
            last.wall.duration_since(start.wall).as_secs_f64()
        };
        if seconds <= 0.0 {
            return None;
        }
        if last.wall.duration_since(start.wall) < self.span() {
            return None;
        }
        let rate = (bytes / 8) as f64 / seconds;
        if rate < self.expected_rate as f64 * 0.5 || rate > self.expected_rate as f64 * 2.0 {
            // A torn or absurd sample (for example the first pair after a
            // stream restart): keep its audio buffered and start over.
            self.start = self.last;
            return None;
        }
        Some(snap_rate(rate))
    }

    fn buffer(&mut self, packet: Vec<u8>, sink: &AudioSink) {
        self.buffered_bytes += packet.len();
        self.buffered.push_back(packet);
        while self.buffered_bytes > self.max_buffered_bytes {
            let Some(oldest) = self.buffered.pop_front() else {
                break;
            };
            self.buffered_bytes -= oldest.len();
            sink.note_dropped(oldest.len());
        }
    }

    fn take(&mut self) -> VecDeque<Vec<u8>> {
        self.buffered_bytes = 0;
        self.start = None;
        self.last = None;
        std::mem::take(&mut self.buffered)
    }
}

/// Polyphase Kaiser-windowed sinc with linear interpolation between phases.
/// Passband stays flat well past 16 kHz for 44.1 -> 48 kHz conversion and the
/// kernel table is precomputed, so no transcendentals run per sample.
struct Resampler {
    step: f64,
    position: f64,
    left: VecDeque<f32>,
    right: VecDeque<f32>,
    kernel: Vec<f32>,
}

impl Resampler {
    fn new(src_rate: f64, dst_rate: f64) -> Self {
        Self {
            step: src_rate / dst_rate,
            position: RESAMPLE_HALF as f64,
            left: VecDeque::new(),
            right: VecDeque::new(),
            kernel: build_kernel(src_rate, dst_rate),
        }
    }

    /// Drops history after a stream gap so the next packet starts clean.
    fn reset(&mut self) {
        self.left.clear();
        self.right.clear();
        self.position = RESAMPLE_HALF as f64;
    }

    fn push(&mut self, input: &[u8], output: &mut Vec<u8>) {
        for frame in input.chunks_exact(8) {
            self.left
                .push_back(f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]));
            self.right
                .push_back(f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]));
        }
        loop {
            let center = self.position.floor() as isize;
            if center + RESAMPLE_HALF as isize >= self.left.len() as isize {
                break;
            }
            let fraction = self.position - self.position.floor();
            let phase = (fraction * RESAMPLE_PHASES as f64).min(RESAMPLE_PHASES as f64);
            let row = phase.floor() as usize;
            let blend = (phase - row as f64) as f32;
            let first = row * RESAMPLE_TAPS;
            let second = first + RESAMPLE_TAPS;
            let mut left = 0.0f64;
            let mut right = 0.0f64;
            for tap in 0..RESAMPLE_TAPS {
                let start = self.kernel[first + tap];
                let end = self.kernel[second + tap];
                let weight = start + (end - start) * blend;
                let sample = center - RESAMPLE_HALF as isize + 1 + tap as isize;
                if sample < 0 || sample as usize >= self.left.len() {
                    continue;
                }
                left += self.left[sample as usize] as f64 * weight as f64;
                right += self.right[sample as usize] as f64 * weight as f64;
            }
            output.extend_from_slice(&(left as f32).to_le_bytes());
            output.extend_from_slice(&(right as f32).to_le_bytes());
            self.position += self.step;
            let drop = (self.position.floor() as usize)
                .saturating_sub(RESAMPLE_HALF)
                .min(self.left.len());
            if drop > 0 {
                self.left.drain(..drop);
                self.right.drain(..drop);
                self.position -= drop as f64;
            }
        }
    }
}

fn build_kernel(src_rate: f64, dst_rate: f64) -> Vec<f32> {
    let cutoff = 0.5 * RESAMPLE_CUTOFF * (dst_rate / src_rate).min(1.0);
    let half = RESAMPLE_HALF as f64;
    let i0_beta = bessel_i0(KAISER_BETA);
    let mut kernel = Vec::with_capacity((RESAMPLE_PHASES + 1) * RESAMPLE_TAPS);
    let mut row = vec![0.0f64; RESAMPLE_TAPS];
    for phase in 0..=RESAMPLE_PHASES {
        let fraction = phase as f64 / RESAMPLE_PHASES as f64;
        let mut sum = 0.0;
        for (tap, slot) in row.iter_mut().enumerate() {
            let distance = half - 1.0 - tap as f64 + fraction;
            let normalized = distance / half;
            let window = if normalized.abs() >= 1.0 {
                0.0
            } else {
                bessel_i0(KAISER_BETA * (1.0 - normalized * normalized).max(0.0).sqrt()) / i0_beta
            };
            let angle = 2.0 * std::f64::consts::PI * cutoff * distance;
            let sinc = if angle.abs() < 1e-9 {
                1.0
            } else {
                angle.sin() / angle
            };
            let weight = 2.0 * cutoff * sinc * window;
            *slot = weight;
            sum += weight;
        }
        if sum.abs() > 1e-9 {
            for weight in &row {
                kernel.push((weight / sum) as f32);
            }
        } else {
            kernel.extend(std::iter::repeat_n(0.0f32, RESAMPLE_TAPS));
        }
    }
    kernel
}

fn bessel_i0(value: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let half = value / 2.0;
    let mut index = 1.0;
    while index < 64.0 {
        let ratio = half / index;
        term *= ratio * ratio;
        sum += term;
        if term < 1e-12 * sum {
            break;
        }
        index += 1.0;
    }
    sum
}

fn ring(shared: &Shared, offset: usize) -> *const u8 {
    // SAFETY: offset is within the ring capacity.
    unsafe { shared.ring().add(offset) }
}

fn snap_rate(measured: f64) -> f64 {
    const COMMON: [f64; 8] = [
        22_050.0, 32_000.0, 44_100.0, 48_000.0, 88_200.0, 96_000.0, 176_400.0, 192_000.0,
    ];
    COMMON
        .iter()
        .copied()
        .filter(|rate| (rate - measured).abs() / rate < RATE_SNAP_TOLERANCE)
        .min_by(|left, right| {
            (left - measured)
                .abs()
                .partial_cmp(&(right - measured).abs())
                .unwrap_or(std::cmp::Ordering::Equal)
        })
        .unwrap_or(measured)
}

fn open_event(pid: u32) -> Option<OwnedHandle> {
    let name = format!("Local\\SpotifyTapEvent_{pid}_v2")
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<u16>>();
    // Only synchronous wait access is needed; the DLL owns the event.
    let access = SYNCHRONIZATION_ACCESS_RIGHTS(0x0010_0000);
    for _ in 0..25 {
        if let Ok(event) = unsafe { OpenEventW(access, false, PCWSTR(name.as_ptr())) } {
            return Some(OwnedHandle(event));
        }
        thread::sleep(Duration::from_millis(20));
    }
    None
}

fn qpc_frequency() -> u64 {
    let mut value = 0i64;
    let _ = unsafe { QueryPerformanceFrequency(&mut value) };
    if value > 0 {
        value as u64
    } else {
        0
    }
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
    let process = OwnedHandle(
        unsafe { OpenProcess(PROCESS_ALL_ACCESS, false, pid) }
            .map_err(|error| format!("Could not open Spotify (PID {pid}): {error}"))?,
    );
    let _ = call_export(process.0, pid, file_name, &path_wide, "StopTap")?;
    Ok(())
}

fn inject(pid: u32, dll_path: &Path) -> Result<StartOutcome, String> {
    let file_name = dll_path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Spotify tap DLL path has no file name".to_owned())?;
    let path_wide: Vec<u16> = dll_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let process = OwnedHandle(
        unsafe { OpenProcess(PROCESS_ALL_ACCESS, false, pid) }
            .map_err(|error| format!("Could not open Spotify (PID {pid}): {error}"))?,
    );

    if module_base(pid, file_name).is_none() {
        load_remote(process.0, &path_wide)?;
        wait_for_module(pid, file_name)?;
    }

    let code = call_export(process.0, pid, file_name, &path_wide, "StartTap")?;
    match code {
        0 => Ok(StartOutcome::Owner),
        ERR_OTHER_OWNER => Ok(StartOutcome::OtherOwner),
        other => Err(format!("Spotify tap setup failed with code {other}")),
    }
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
    let thread = OwnedHandle(
        unsafe {
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
        .map_err(|error| format!("Could not call {export} in Spotify: {error}"))?,
    );
    wait_for_thread(thread.0, export)?;
    let mut code = 0u32;
    let _ = unsafe { GetExitCodeThread(thread.0, &mut code) };
    Ok(code)
}

fn load_remote(process: HANDLE, path_wide: &[u16]) -> Result<(), String> {
    let size = std::mem::size_of_val(path_wide);
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
    let thread = OwnedHandle(
        unsafe {
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
        .map_err(|error| format!("Could not load the tap DLL in Spotify: {error}"))?,
    );
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
        Err(format!(
            "Timed out during {operation} (wait result {result:?})"
        ))
    }
}

fn kernel32() -> Result<HMODULE, String> {
    unsafe { GetModuleHandleW(w!("kernel32.dll")) }
        .map_err(|error| format!("Could not resolve kernel32.dll: {error}"))
}

fn module_base(pid: u32, file_name: &str) -> Option<usize> {
    let snapshot =
        unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid) }.ok()?;
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

fn open_mapping(name: &str) -> Result<HANDLE, String> {
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    for _ in 0..50 {
        if let Ok(mapping) =
            unsafe { OpenFileMappingW(FILE_MAP_ALL_ACCESS.0, false, PCWSTR(wide.as_ptr())) }
        {
            return Ok(mapping);
        }
        thread::sleep(Duration::from_millis(20));
    }
    Err(format!(
        "Could not open the Spotify tap shared memory ({name})"
    ))
}

fn utf16_z(value: &[u16]) -> String {
    let end = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
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

    fn tone(frames: usize, rate: f64, hz: f64) -> Vec<u8> {
        let mut input = Vec::with_capacity(frames * 8);
        for index in 0..frames {
            let value = ((index as f64 / rate) * hz * std::f64::consts::TAU).sin() as f32 * 0.5;
            input.extend_from_slice(&value.to_le_bytes());
            input.extend_from_slice(&value.to_le_bytes());
        }
        input
    }

    fn rms(data: &[u8]) -> f64 {
        let mut sum = 0.0;
        let mut count = 0;
        for frame in data.chunks_exact(8) {
            let value = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]) as f64;
            sum += value * value;
            count += 1;
        }
        (sum / count.max(1) as f64).sqrt()
    }

    #[test]
    fn resampler_produces_destination_rate_frames() {
        let mut resampler = Resampler::new(44_100.0, 48_000.0);
        let mut output = Vec::new();
        let input = tone(44_100, 44_100.0, 1_000.0);
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
    fn resampler_keeps_a_15khz_tone_intact() {
        let mut resampler = Resampler::new(44_100.0, 48_000.0);
        let mut output = Vec::new();
        let input = tone(44_100, 44_100.0, 15_000.0);
        for chunk in input.chunks(441 * 8) {
            resampler.push(chunk, &mut output);
        }
        let expected = rms(&input[4_410 * 8..]);
        let actual = rms(&output[4_800 * 8..]);
        let ratio = actual / expected;
        assert!(ratio > 0.97 && ratio < 1.03, "15 kHz RMS ratio: {ratio}");
    }

    #[test]
    fn snaps_measured_rate_to_common_clock() {
        assert_eq!(snap_rate(44_095.5), 44_100.0);
        assert_eq!(snap_rate(47_990.0), 48_000.0);
        assert_eq!(snap_rate(47_000.0), 47_000.0);
    }

    #[test]
    fn sanitizes_non_finite_and_extreme_samples_in_place() {
        let mut packet = Vec::new();
        packet.extend_from_slice(&f32::NAN.to_le_bytes());
        packet.extend_from_slice(&0.0f32.to_le_bytes());
        packet.extend_from_slice(&16.0f32.to_le_bytes());
        packet.extend_from_slice(&0.25f32.to_le_bytes());
        sanitize_pcm(&mut packet);
        let first = f32::from_le_bytes([packet[0], packet[1], packet[2], packet[3]]);
        let extreme = f32::from_le_bytes([packet[8], packet[9], packet[10], packet[11]]);
        let kept = f32::from_le_bytes([packet[12], packet[13], packet[14], packet[15]]);
        assert_eq!(first, 0.0);
        assert_eq!(extreme, 0.0);
        assert!((kept - 0.25).abs() < 1e-6);
        assert_eq!(packet.len(), 16);
    }

    #[test]
    fn rate_probe_uses_qpc_pairs_and_buffers_audio() {
        let mut probe = RateProbe::new(48_000, 10_000_000, true);
        let packet = vec![0u8; 480 * 8];
        probe.buffer(
            packet,
            &AudioSink::new(crate::capture::Mailbox::new(), || true),
        );
        probe.observe_qpc(0, 0, Instant::now());
        probe.observe_qpc(
            44_100 * 8,
            10_000_000,
            Instant::now() + Duration::from_millis(1_000),
        );
        let rate = probe.decide().unwrap();
        assert_eq!(rate, 44_100.0);
        assert_eq!(probe.take().len(), 1);
    }

    #[test]
    fn rate_probe_needs_a_full_span() {
        let mut probe = RateProbe::new(48_000, 10_000_000, true);
        let start = Instant::now();
        probe.observe_qpc(0, 0, start);
        probe.observe_qpc(1_000 * 8, 1_000_000, start + Duration::from_millis(100));
        assert!(probe.decide().is_none());
    }
}
