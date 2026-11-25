#![deny(unsafe_op_in_unsafe_fn)]

pub mod capture;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
#[cfg_attr(test, allow(dead_code))]
mod output;
#[cfg(target_os = "windows")]
#[cfg_attr(test, allow(dead_code))]
mod process;
#[cfg(target_os = "windows")]
#[cfg_attr(test, allow(dead_code))]
mod tap;
#[cfg(target_os = "windows")]
mod windows;

// Keep the Node runtime out of pure Rust unit-test executables.
#[cfg(all(feature = "node-addon", not(test)))]
mod addon;
