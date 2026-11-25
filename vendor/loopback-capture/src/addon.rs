use crate::capture::{lock, AudioSink, CaptureMode, CaptureOptions, Mailbox, Session};
use napi::{
    bindgen_prelude::{Buffer, Function},
    threadsafe_function::{ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode},
    CallContext, Env, Error, JsFunction, JsNumber, JsObject, JsString, JsUndefined, JsUnknown,
    Property, Result, Status, ValueType,
};
use napi_derive::{js_function, module_exports};
use std::sync::{Arc, Mutex, Weak};

type Registry = Arc<Mutex<Vec<Weak<Session>>>>;

// One cleanup hook per Node environment, including Worker environments. It runs
// before Node disposes its callback handles, and never invokes JavaScript.
fn registry(env: &mut Env) -> Result<Registry> {
    if let Some(registry) = env.get_instance_data::<Registry>()? {
        return Ok(registry.clone());
    }
    let registry: Registry = Arc::default();
    env.set_instance_data(registry.clone(), (), |_| {})?;
    env.add_env_cleanup_hook(registry.clone(), |registry| {
        let sessions: Vec<_> = lock(&registry).iter().filter_map(Weak::upgrade).collect();
        for session in sessions {
            let _ = session.stop();
        }
    })?;
    Ok(registry)
}

#[derive(Default)]
struct Capture {
    session: Option<Arc<Session>>,
    #[cfg(target_os = "windows")]
    tap: Option<(u32, String)>,
}

fn audio_sink(
    env: Env,
    callback: napi::bindgen_prelude::FunctionRef<(Buffer,), JsUnknown>,
) -> Result<AudioSink> {
    let mailbox = Mailbox::new();
    let delivery = mailbox.clone();
    // The dispatcher and user callback exist only on the JS thread. Workers
    // pass owned bytes through a mailbox, never JsValues or borrowed buffers.
    let dispatcher = env.create_function_from_closure("deliverAudio", move |ctx| {
        let packets = delivery.drain();
        for packet in packets {
            if !delivery.active() {
                break;
            }
            // A callback may stop/restart capture. Never hold a lock or a
            // mutable reference to Capture across this reentrant JS call.
            callback
                .borrow_back(ctx.env)?
                .call((Buffer::from(packet),))?;
        }
        ctx.env.get_undefined()
    })?;
    // Audio is bounded in the mailbox, not in napi-rs' TSFN. Coalescing means
    // at most one wakeup is queued, regardless of how far JS falls behind.
    let tsfn: ThreadsafeFunction<(), ErrorStrategy::Fatal> =
        dispatcher.create_threadsafe_function(0, |_ctx| Ok(Vec::<JsUnknown>::new()))?;
    Ok(AudioSink::new(mailbox, move || {
        tsfn.call((), ThreadsafeFunctionCallMode::NonBlocking) == Status::Ok
    }))
}

impl Capture {
    fn start(
        &mut self,
        mut env: Env,
        mode: CaptureMode,
        callback: napi::bindgen_prelude::FunctionRef<(Buffer,), JsUnknown>,
        options: CaptureOptions,
    ) -> Result<()> {
        if self.session.is_some() {
            return Err(Error::from_reason(
                "Capture already started on this instance",
            ));
        }
        let registry = registry(&mut env)?;
        let sink = audio_sink(env, callback)?;
        let session = Session::start_with_options(mode, sink, options).map_err(Error::from_reason)?;
        let mut sessions = lock(&registry);
        sessions.retain(|session| session.strong_count() > 0);
        sessions.push(Arc::downgrade(&session));
        self.session = Some(session);
        Ok(())
    }

    #[cfg(target_os = "windows")]
    fn start_tap(
        &mut self,
        mut env: Env,
        pid: u32,
        dll_path: String,
        sample_rate: u32,
        callback: napi::bindgen_prelude::FunctionRef<(Buffer,), JsUnknown>,
    ) -> Result<crate::tap::TapFormat> {
        if self.session.is_some() {
            return Err(Error::from_reason(
                "Capture already started on this instance",
            ));
        }
        let registry = registry(&mut env)?;
        let sink = audio_sink(env, callback)?;
        let tap_path = dll_path.clone();
        let (session, format) = crate::tap::start_session(
            pid,
            std::path::Path::new(&dll_path),
            sample_rate,
            sink,
        )
        .map_err(Error::from_reason)?;
        let mut sessions = lock(&registry);
        sessions.retain(|session| session.strong_count() > 0);
        sessions.push(Arc::downgrade(&session));
        self.session = Some(session);
        self.tap = Some((pid, tap_path));
        Ok(format)
    }

    fn stop(&mut self) -> Result<()> {
        let session_result = if let Some(session) = self.session.take() {
            session.stop().map_err(Error::from_reason)
        } else {
            Ok(())
        };
        #[cfg(target_os = "windows")]
        if let Some((pid, path)) = self.tap.take() {
            let _ = crate::tap::stop(pid, std::path::Path::new(&path));
        }
        session_result
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}

fn invalid_type(env: &Env, message: &str) -> Result<JsUndefined> {
    env.throw_type_error(message, None)?;
    env.get_undefined()
}

fn process_id(env: &Env, value: JsUnknown, name: &str) -> Result<Option<u32>> {
    if value.get_type()? != ValueType::Number {
        env.throw_type_error(&format!("{name} must be a number"), None)?;
        return Ok(None);
    }
    let number = JsNumber::try_from(value)?.get_double()?;
    let maximum = if cfg!(target_os = "windows") {
        u32::MAX
    } else {
        i32::MAX as u32
    };
    if !number.is_finite() || number < 1.0 || number > maximum as f64 || number.fract() != 0.0 {
        env.throw_range_error(
            &format!("{name} must be an integer between 1 and {maximum}"),
            None,
        )?;
        return Ok(None);
    }
    Ok(Some(number as u32))
}

#[js_function(1)]
fn constructor(ctx: CallContext) -> Result<JsUndefined> {
    let mut this: JsObject = ctx.this()?;
    ctx.env.wrap(&mut this, Capture::default())?;
    ctx.env.get_undefined()
}

#[js_function(3)]
fn start(ctx: CallContext) -> Result<JsUndefined> {
    if ctx.length != 2 || ctx.get::<JsUnknown>(1)?.get_type()? != ValueType::Function {
        return invalid_type(
            ctx.env,
            "Expected start(processId: number, onData: (chunk: Buffer) => void)",
        );
    }
    let Some(pid) = process_id(ctx.env, ctx.get(0)?, "processId")? else {
        return ctx.env.get_undefined();
    };
    let callback = ctx.get::<Function<(Buffer,), JsUnknown>>(1)?.create_ref()?;
    let this: JsObject = ctx.this()?;
    ctx.env
        .unwrap::<Capture>(&this)?
        .start(
            *ctx.env,
            CaptureMode::Include(pid),
            callback,
            CaptureOptions::default(),
        )?;
    ctx.env.get_undefined()
}

#[js_function(4)]
fn start_with_format(ctx: CallContext) -> Result<JsUndefined> {
    if ctx.length != 4
        || ctx.get::<JsUnknown>(1)?.get_type()? != ValueType::Function
        || ctx.get::<JsUnknown>(2)?.get_type()? != ValueType::String
        || ctx.get::<JsUnknown>(3)?.get_type()? != ValueType::Number
    {
        return invalid_type(
            ctx.env,
            "Expected startWithFormat(processId: number, onData: (chunk: Buffer) => void, format: \"f32\" | \"s16\", sampleRate: number)",
        );
    }
    let Some(pid) = process_id(ctx.env, ctx.get(0)?, "processId")? else {
        return ctx.env.get_undefined();
    };
    let format = ctx.get::<JsString>(2)?;
    let format = format.into_utf8()?;
    let float32 = match format.as_str()? {
        "f32" => true,
        "s16" => false,
        _ => {
            ctx.env
                .throw_range_error("format must be \"f32\" or \"s16\"", None)?;
            return ctx.env.get_undefined();
        }
    };
    let sample_rate = ctx.get::<JsNumber>(3)?.get_double()?;
    if !sample_rate.is_finite()
        || !(8_000.0..=192_000.0).contains(&sample_rate)
        || sample_rate.fract() != 0.0
    {
        ctx.env.throw_range_error(
            "sampleRate must be an integer between 8000 and 192000",
            None,
        )?;
        return ctx.env.get_undefined();
    }
    let callback = ctx.get::<Function<(Buffer,), JsUnknown>>(1)?.create_ref()?;
    let this: JsObject = ctx.this()?;
    ctx.env
        .unwrap::<Capture>(&this)?
        .start(
            *ctx.env,
            CaptureMode::Include(pid),
            callback,
            CaptureOptions {
                float32,
                sample_rate: sample_rate as u32,
            },
        )?;
    ctx.env.get_undefined()
}

#[cfg(target_os = "windows")]
#[js_function(4)]
fn start_tap(ctx: CallContext) -> Result<JsObject> {
    if ctx.length != 4
        || ctx.get::<JsUnknown>(1)?.get_type()? != ValueType::String
        || ctx.get::<JsUnknown>(2)?.get_type()? != ValueType::Function
        || ctx.get::<JsUnknown>(3)?.get_type()? != ValueType::Number
    {
        ctx.env.throw_type_error(
            "Expected startTap(processId: number, dllPath: string, onData: (chunk: Buffer) => void, sampleRate: number)",
            None,
        )?;
        return ctx.env.create_object();
    }
    let Some(pid) = process_id(ctx.env, ctx.get(0)?, "processId")? else {
        return ctx.env.create_object();
    };
    let dll_path = ctx.get::<JsString>(1)?;
    let dll_path = dll_path.into_utf8()?;
    let dll_path = dll_path.as_str()?.to_owned();
    let callback = ctx.get::<Function<(Buffer,), JsUnknown>>(2)?.create_ref()?;
    let sample_rate = ctx.get::<JsNumber>(3)?.get_double()?;
    if !sample_rate.is_finite()
        || !(8_000.0..=192_000.0).contains(&sample_rate)
        || sample_rate.fract() != 0.0
    {
        ctx.env.throw_range_error(
            "sampleRate must be an integer between 8000 and 192000",
            None,
        )?;
        return ctx.env.create_object();
    }
    let this: JsObject = ctx.this()?;
    let format = ctx.env.unwrap::<Capture>(&this)?.start_tap(
        *ctx.env,
        pid,
        dll_path,
        sample_rate as u32,
        callback,
    )?;
    let result = ctx.env.create_object()?;
    let mut result = result;
    result.set_named_property("sampleRate", ctx.env.create_uint32(format.sample_rate)?)?;
    result.set_named_property("channels", ctx.env.create_uint32(format.channels as u32)?)?;
    Ok(result)
}

#[js_function(3)]
fn start_system_audio(ctx: CallContext) -> Result<JsUndefined> {
    if ctx.length < 1
        || ctx.length > 2
        || ctx.get::<JsUnknown>(0)?.get_type()? != ValueType::Function
    {
        return invalid_type(
            ctx.env,
            "Expected startSystemAudio(onData: (chunk: Buffer) => void, excludeProcessId?: number)",
        );
    }
    let mode = if ctx.length == 2 && ctx.get::<JsUnknown>(1)?.get_type()? != ValueType::Undefined {
        let Some(pid) = process_id(ctx.env, ctx.get(1)?, "excludeProcessId")? else {
            return ctx.env.get_undefined();
        };
        CaptureMode::Exclude(pid)
    } else {
        CaptureMode::System
    };
    let callback = ctx.get::<Function<(Buffer,), JsUnknown>>(0)?.create_ref()?;
    let this: JsObject = ctx.this()?;
    ctx.env
        .unwrap::<Capture>(&this)?
        .start(
            *ctx.env,
            mode,
            callback,
            CaptureOptions::default(),
        )?;
    ctx.env.get_undefined()
}

#[js_function(1)]
fn stop(ctx: CallContext) -> Result<JsUndefined> {
    let this: JsObject = ctx.this()?;
    ctx.env.unwrap::<Capture>(&this)?.stop()?;
    ctx.env.get_undefined()
}

#[js_function(1)]
fn last_error(ctx: CallContext) -> Result<Option<String>> {
    let this: JsObject = ctx.this()?;
    Ok(ctx
        .env
        .unwrap::<Capture>(&this)?
        .session
        .as_ref()
        .and_then(|session| session.error()))
}

#[module_exports]
fn init(mut exports: JsObject, env: Env) -> Result<()> {
    let mut properties = vec![
        Property::new("start")?.with_method(start),
        Property::new("startWithFormat")?.with_method(start_with_format),
        Property::new("startSystemAudio")?.with_method(start_system_audio),
        Property::new("stop")?.with_method(stop),
        Property::new("lastError")?.with_getter(last_error),
    ];
    #[cfg(target_os = "windows")]
    properties.push(Property::new("startTap")?.with_method(start_tap));
    let constructor: JsFunction = env.define_class("LoopbackCapture", constructor, &properties)?;
    exports.set_named_property("LoopbackCapture", constructor)?;
    exports.set_named_property("supportsFloat32", true)?;
    #[cfg(target_os = "windows")]
    {
        exports.set_named_property("supportsTap", true)?;
        let find_process_tree = env.create_function_from_closure("findProcessTree", |ctx| {
            let image_name = ctx.get::<JsString>(0)?.into_utf8()?;
            let pids = crate::process::find_process_tree(image_name.as_str()?)
                .map_err(Error::from_reason)?;
            let mut array = ctx.env.create_array_with_length(pids.len())?;
            for (index, pid) in pids.iter().enumerate() {
                array.set_element(index as u32, ctx.env.create_uint32(*pid)?)?;
            }
            Ok(array)
        })?;
        exports.set_named_property("findProcessTree", find_process_tree)?;
    }
    Ok(())
}
