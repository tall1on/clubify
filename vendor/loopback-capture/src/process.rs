//! Windows process-tree discovery used to find the real Spotify main process.

use std::{collections::HashMap, mem::size_of};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    },
};

/// Returns matching PIDs with the tree root first. The root is the process
/// whose parent is not part of the same image set, preferring the largest tree.
pub fn find_process_tree(image_name: &str) -> Result<Vec<u32>, String> {
    let snapshot = snapshot()?;
    let result = read_processes(snapshot, image_name);
    let _ = unsafe { CloseHandle(snapshot) };
    result
}

fn snapshot() -> Result<HANDLE, String> {
    // SAFETY: process-wide snapshot, no borrowed inputs.
    unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| format!("Could not enumerate processes: {error}"))
}

fn read_processes(snapshot: HANDLE, image_name: &str) -> Result<Vec<u32>, String> {
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut matches: Vec<(u32, u32)> = Vec::new();
    // SAFETY: entry is initialized with dwSize and owned by this call.
    if unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok() {
        loop {
            if image_name_matches(&entry.szExeFile, image_name) {
                matches.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
            // SAFETY: same initialized entry reused for each snapshot item.
            if unsafe { Process32NextW(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
    }
    Ok(order_processes(&matches))
}

fn image_name_matches(candidate: &[u16], image_name: &str) -> bool {
    let end = candidate
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(candidate.len());
    let candidate = String::from_utf16_lossy(&candidate[..end]);
    candidate.eq_ignore_ascii_case(image_name)
}

fn order_processes(entries: &[(u32, u32)]) -> Vec<u32> {
    if entries.is_empty() {
        return Vec::new();
    }
    let parents: HashMap<u32, u32> = entries.iter().copied().collect();
    let roots: Vec<u32> = entries
        .iter()
        .filter(|(pid, parent)| *pid != *parent && !parents.contains_key(parent))
        .map(|(pid, _)| *pid)
        .collect();
    let root = roots
        .iter()
        .copied()
        .max_by_key(|root| descendant_count(*root, &parents))
        .or_else(|| entries.iter().map(|(pid, _)| *pid).min())
        .unwrap_or(entries[0].0);
    let mut ordered = vec![root];
    let mut rest: Vec<u32> = entries
        .iter()
        .map(|(pid, _)| *pid)
        .filter(|pid| *pid != root)
        .collect();
    rest.sort_unstable();
    ordered.extend(rest);
    ordered
}

fn descendant_count(root: u32, parents: &HashMap<u32, u32>) -> usize {
    parents
        .iter()
        .filter(|(pid, _)| **pid != root && is_descendant(**pid, root, parents))
        .count()
}

fn is_descendant(mut pid: u32, root: u32, parents: &HashMap<u32, u32>) -> bool {
    for _ in 0..parents.len() {
        let Some(parent) = parents.get(&pid) else {
            return false;
        };
        if *parent == root {
            return true;
        }
        if *parent == pid {
            return false;
        }
        pid = *parent;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_root_even_when_it_has_a_higher_pid() {
        // 900 is the main process; 12 and 40 are reused lower child PIDs.
        let entries = [(900, 1), (12, 900), (40, 900), (55, 12)];
        assert_eq!(order_processes(&entries), vec![900, 12, 40, 55]);
    }

    #[test]
    fn prefers_the_largest_tree_when_multiple_roots_exist() {
        let entries = [(10, 1), (11, 10), (20, 1), (21, 20), (22, 20)];
        assert_eq!(order_processes(&entries), vec![20, 10, 11, 21, 22]);
    }

    #[test]
    fn handles_empty_and_cyclic_trees() {
        assert!(order_processes(&[]).is_empty());
        assert_eq!(order_processes(&[(5, 6), (6, 5)])[0], 5);
    }

    #[test]
    fn matches_image_name_case_insensitively() {
        let mut name = vec![0u16; 260];
        for (index, unit) in "Spotify.exe".encode_utf16().enumerate() {
            name[index] = unit;
        }
        assert!(image_name_matches(&name, "spotify.exe"));
        assert!(image_name_matches(&name, "Spotify.exe"));
        assert!(!image_name_matches(&name, "NotSpotify.exe"));
    }
}
