use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Cursor, Read};
use zip::ZipArchive;

const MAX_APK_SIZE: usize = 200 * 1024 * 1024;
const MAX_MANIFEST_SIZE: u64 = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct ApkReport {
    pub scanner: String,
    pub file_name: String,
    pub file_size: usize,
    pub sha256: String,
    pub package_name: Option<String>,
    pub permissions: Vec<String>,
    pub risk_score: u8,
    pub risk_level: String,
    pub findings: Vec<String>,
    pub detection: String,
    pub confidence: String,
    pub verdict_note: String,
}

fn read_u16(data: &[u8], pos: usize) -> Option<u16> {
    Some(u16::from_le_bytes(data.get(pos..pos + 2)?.try_into().ok()?))
}

fn read_u32(data: &[u8], pos: usize) -> Option<u32> {
    Some(u32::from_le_bytes(data.get(pos..pos + 4)?.try_into().ok()?))
}

// Reads Android's binary XML string pool.
fn extract_string_pool(data: &[u8]) -> Vec<String> {
    let mut strings = Vec::new();
    let mut pos = 8usize;

    while pos + 8 <= data.len() {
        let chunk_type = match read_u16(data, pos) {
            Some(v) => v,
            None => break,
        };

        let header_size = match read_u16(data, pos + 2) {
            Some(v) => v as usize,
            None => break,
        };

        let chunk_size = match read_u32(data, pos + 4) {
            Some(v) => v as usize,
            None => break,
        };

        if chunk_size < 8 || pos + chunk_size > data.len() {
            break;
        }

        if chunk_type == 0x0001 && header_size >= 28 && chunk_size >= header_size {
            let count = read_u32(data, pos + 8).unwrap_or(0) as usize;
            let flags = read_u32(data, pos + 16).unwrap_or(0);
            let strings_start = read_u32(data, pos + 20).unwrap_or(0) as usize;
            let utf8 = (flags & 0x100) != 0;

            let safe_count = count.min(100_000);

            for i in 0..safe_count {
                let offset_pos = pos + header_size + i * 4;
                let string_offset = match read_u32(data, offset_pos) {
                    Some(v) => v as usize,
                    None => break,
                };

                let start = match pos
                    .checked_add(strings_start)
                    .and_then(|v| v.checked_add(string_offset))
                {
                    Some(v) if v < pos + chunk_size => v,
                    _ => continue,
                };

                if utf8 {
                    let first = match data.get(start) {
                        Some(v) => *v as usize,
                        None => continue,
                    };

                    let (char_count, length_bytes) = if first & 0x80 != 0 {
                        let second = match data.get(start + 1) {
                            Some(v) => *v as usize,
                            None => continue,
                        };
                        (((first & 0x7f) << 8) | second, 2)
                    } else {
                        (first, 1)
                    };

                    let len_pos = start + length_bytes;
                    let first_len = match data.get(len_pos) {
                        Some(v) => *v as usize,
                        None => continue,
                    };

                    let (byte_count, byte_len_bytes) = if first_len & 0x80 != 0 {
                        let second = match data.get(len_pos + 1) {
                            Some(v) => *v as usize,
                            None => continue,
                        };
                        (((first_len & 0x7f) << 8) | second, 2)
                    } else {
                        (first_len, 1)
                    };

                    let text_start = len_pos + byte_len_bytes;
                    let text_end = match text_start.checked_add(byte_count) {
                        Some(v) if v <= pos + chunk_size => v,
                        _ => continue,
                    };

                    let _ = char_count;
                    strings.push(
                        String::from_utf8_lossy(&data[text_start..text_end]).into_owned(),
                    );
                } else {
                    let length = match read_u16(data, start) {
                        Some(v) => v as usize,
                        None => continue,
                    };
                    let text_start = start + 2;
                    let text_end = match text_start.checked_add(length * 2) {
                        Some(v) if v <= pos + chunk_size => v,
                        _ => continue,
                    };

                    let units: Vec<u16> = data[text_start..text_end]
                        .chunks_exact(2)
                        .map(|b| u16::from_le_bytes([b[0], b[1]]))
                        .collect();

                    strings.push(String::from_utf16_lossy(&units));
                }
            }

            return strings;
        }

        pos += chunk_size;
    }

    strings
}

pub fn scan_apk(
    bytes: &[u8],
    file_name: &str,
) -> Result<ApkReport, String> {
    if bytes.is_empty() {
        return Err("Uploaded APK is empty".into());
    }

    if bytes.len() > MAX_APK_SIZE {
        return Err("APK exceeds the 200 MB upload limit".into());
    }

    if !file_name.to_lowercase().ends_with(".apk") {
        return Err("Only .apk files are accepted".into());
    }

    let hash = format!("{:x}", Sha256::digest(bytes));

    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor)
        .map_err(|_| "Invalid APK or corrupted ZIP archive".to_string())?;

    let manifest = archive
        .by_name("AndroidManifest.xml")
        .map_err(|_| "AndroidManifest.xml not found. This may not be a valid APK".to_string())?;

    if manifest.size() > MAX_MANIFEST_SIZE {
        return Err("AndroidManifest.xml exceeds the allowed size".into());
    }

    let mut manifest_bytes = Vec::new();
    manifest
        .take(MAX_MANIFEST_SIZE + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| "Could not read AndroidManifest.xml".to_string())?;

    if manifest_bytes.len() as u64 > MAX_MANIFEST_SIZE {
        return Err("AndroidManifest.xml exceeds the allowed size".into());
    }

    let mut strings = extract_string_pool(&manifest_bytes);

    // Also supports readable text XML manifests.
    if strings.is_empty() {
        let text = String::from_utf8_lossy(&manifest_bytes);
        strings = text
            .split(|c: char| c.is_whitespace() || c == '"' || c == '\'')
            .map(str::to_string)
            .collect();
    }

    let mut permissions: Vec<String> = strings
        .iter()
        .filter(|s| {
            s.starts_with("android.permission.")
                || s.starts_with("com.android.permission.")
        })
        .cloned()
        .collect();

    permissions.sort();
    permissions.dedup();

    let package_name = strings
        .iter()
        .find(|s| {
            s.contains('.')
                && !s.starts_with("android.")
                && !s.starts_with("com.android.")
                && !s.starts_with("http")
                && s.len() < 200
        })
        .cloned();

    let mut score: u16 = 0;
    let mut findings = Vec::new();

    let sensitive_permissions = [
        "android.permission.READ_SMS",
        "android.permission.RECEIVE_SMS",
        "android.permission.SEND_SMS",
        "android.permission.READ_CALL_LOG",
        "android.permission.WRITE_CALL_LOG",
        "android.permission.RECORD_AUDIO",
        "android.permission.READ_CONTACTS",
        "android.permission.READ_PHONE_STATE",
        "android.permission.REQUEST_INSTALL_PACKAGES",
        "android.permission.SYSTEM_ALERT_WINDOW",
        "android.permission.BIND_ACCESSIBILITY_SERVICE",
    ];

    for permission in &permissions {
        if sensitive_permissions.contains(&permission.as_str()) {
            score += 8;
            findings.push(format!(
                "Sensitive permission declared: {}",
                permission
            ));
        }
    }

    if permissions.is_empty() {
        findings.push(
            "No permissions extracted. Manifest parsing may be incomplete.".into(),
        );
    }

    if findings.is_empty() {
        findings.push("No flagged permissions found in the extracted manifest.".into());
    }

    let risk_score = score.min(100) as u8;

    let risk_level = match risk_score {
    0..=19 => "low",
    20..=49 => "medium",
    50..=100 => "high",
    _ => "high",
};

    Ok(ApkReport {
        scanner: "RayX Shield APK Scanner 0.1.0".into(),
        file_name: file_name.to_string(),
        file_size: bytes.len(),
        sha256: hash,
        package_name,
        permissions,
        risk_score,
        risk_level: risk_level.into(),
        findings,
        detection: "static_manifest_analysis".into(),
        confidence: "limited".into(),
        verdict_note:
            "Declared permissions are indicators, not proof of malware. This scanner does not execute the APK or inspect all DEX code.".into(),
    })
}