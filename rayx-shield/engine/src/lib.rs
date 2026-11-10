pub mod apk;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, net::IpAddr, path::PathBuf, time::Duration};
use url::Url;

#[derive(Debug, Serialize, Deserialize)]
pub struct ThreatDatabase {
    pub version: String,
    pub last_updated: String,
    pub domains: Vec<ThreatEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreatEntry {
    pub domain: String,
    pub category: String,
    pub severity: u8,
    pub description: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    Low,
    Suspicious,
    High,
    Critical,
}

#[derive(Debug, Serialize)]
pub struct ScanReport {
    pub scanner: String,
    pub input: String,
    pub normalized_url: String,
    pub domain: String,
    pub risk_score: u8,
    pub risk_level: RiskLevel,
    pub reputation: String,
    pub detection: String,
    pub confidence: String,
    pub findings: Vec<String>,
    pub verdict_note: String,
}

fn database_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../threat-intelligence/domains.json")
}

pub fn load_database() -> Result<ThreatDatabase, String> {
    let path = database_path();

    let content =
        fs::read_to_string(&path).map_err(|e| format!("Cannot read threat database: {}", e))?;

    serde_json::from_str(&content).map_err(|e| format!("Threat database error: {}", e))
}

fn save_database(db: &ThreatDatabase) -> Result<(), String> {
    let path = database_path();

    let json = serde_json::to_string_pretty(db).map_err(|e| e.to_string())?;

    let temp_path = path.with_extension("json.tmp");

    fs::write(&temp_path, json).map_err(|e| format!("Database write failed: {}", e))?;

    fs::rename(&temp_path, &path).map_err(|e| format!("Database replace failed: {}", e))?;

    Ok(())
}

fn match_domain<'a>(host: &str, entries: &'a [ThreatEntry]) -> Option<&'a ThreatEntry> {
    entries.iter().find(|entry| {
        let domain = entry.domain.trim().trim_end_matches('.').to_lowercase();

        host == domain || host.ends_with(&format!(".{}", domain))
    })
}

/// Downloads an authorized plain-text feed.
/// Each non-empty line must contain an HTTP or HTTPS URL.
pub fn update_feed(feed_url: &str) -> Result<usize, String> {
    let feed = Url::parse(feed_url).map_err(|_| "Invalid feed URL".to_string())?;

    if feed.scheme() != "https" {
        return Err("Threat feed must use HTTPS".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("RayX-Shield/0.3")
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(feed)
        .send()
        .map_err(|e| format!("Feed request failed: {}", e))?
        .error_for_status()
        .map_err(|e| format!("Feed HTTP error: {}", e))?;

    let body = response
        .text()
        .map_err(|e| format!("Feed read failed: {}", e))?;

    if body.is_empty() || body.len() > 10_000_000 {
        return Err("Feed is empty or exceeds the 10 MB limit".into());
    }

    let mut domains = BTreeMap::new();

    for line in body.lines() {
        let line = line.trim();

        if line.is_empty() || line.starts_with('#') {
            continue;
        }

        let parsed = match Url::parse(line) {
            Ok(url) => url,
            Err(_) => continue,
        };

        if !["http", "https"].contains(&parsed.scheme()) {
            continue;
        }

        let Some(host) = parsed.host_str() else {
            continue;
        };

        let domain = host.trim_end_matches('.').to_lowercase();

        if domain.is_empty() {
            continue;
        }

        domains.insert(
            domain.clone(),
            ThreatEntry {
                domain,
                category: "phishing_feed".into(),
                severity: 90,
                description: "Listed in configured threat feed".into(),
            },
        );
    }

    if domains.is_empty() {
        return Err("No valid URLs found. Existing database was preserved.".into());
    }

    let entries: Vec<ThreatEntry> = domains.into_values().collect();

    let db = ThreatDatabase {
        version: "1.1.0".into(),
        last_updated: format!(
            "{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs()
        ),
        domains: entries,
    };

    let count = db.domains.len();

    save_database(&db)?;

    Ok(count)
}

pub fn scan_url(input: &str) -> Result<ScanReport, String> {
    let input = input.trim();

    if input.is_empty() || input.len() > 8192 {
        return Err("Invalid URL length".into());
    }

    let url = Url::parse(input).map_err(|_| "Invalid URL format".to_string())?;

    if !["http", "https"].contains(&url.scheme()) {
        return Err("Only HTTP and HTTPS are supported".into());
    }

    let host = url
        .host_str()
        .ok_or("Missing hostname")?
        .trim_end_matches('.')
        .to_lowercase();

    let database = load_database()?;

    let mut score: u16 = 0;
    let mut findings = Vec::new();

    let reputation;

    if let Some(threat) = match_domain(&host, &database.domains) {
        score = score.max(threat.severity.min(100) as u16);

        reputation = "listed_in_feed".to_string();

        findings.push(format!(
            "Threat feed match: {} - {}",
            threat.category, threat.description
        ));
    } else {
        reputation = "unknown".to_string();
    }

    if url.scheme() == "http" {
        score += 10;
        findings.push("Connection does not use HTTPS".into());
    }

    if !url.username().is_empty() || url.password().is_some() {
        score += 30;
        findings.push("Embedded URL credentials detected".into());
    }

    if host.parse::<IpAddr>().is_ok() {
        score += 25;
        findings.push("IP address used instead of domain".into());
    }

    if host.split('.').any(|part| part.starts_with("xn--")) {
        score += 20;
        findings.push("Punycode domain detected".into());
    }

    let shorteners = ["bit.ly", "tinyurl.com", "t.co", "is.gd", "cutt.ly", "rb.gy"];

    if shorteners.contains(&host.as_str()) {
        score += 15;
        findings.push("URL shortener detected".into());
    }

    if host.split('.').count() >= 6 {
        score += 10;
        findings.push("Excessive subdomains detected".into());
    }

    if let Some(port) = url.port() {
        if ![80, 443, 8080, 8443].contains(&port) {
            score += 10;
            findings.push(format!("Unusual port: {}", port));
        }
    }

    if input.len() > 300 {
        score += 5;
        findings.push("Unusually long URL".into());
    }

    let risk_score = score.min(100) as u8;

    let risk_level = match risk_score {
        0..=19 => RiskLevel::Low,
        20..=49 => RiskLevel::Suspicious,
        50..=79 => RiskLevel::High,
        _ => RiskLevel::Critical,
    };

    if findings.is_empty() {
        findings.push("No suspicious indicators detected".into());
    }

    let detection = if reputation == "listed_in_feed" {
        "threat_feed_and_heuristics"
    } else {
        "heuristics_only"
    };

    let confidence = if reputation == "listed_in_feed" {
        "feed_match"
    } else {
        "limited"
    };

    Ok(ScanReport {
        scanner: "RayX Shield URL Scanner 0.3.0".into(),
        input: input.to_string(),
        normalized_url: url.to_string(),
        domain: host,
        risk_score,
        risk_level,
        reputation,
        detection: detection.into(),
        confidence: confidence.into(),
        findings,
        verdict_note: "Feed matches are indicators, not proof. Unknown does not mean safe.".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_url() {
        assert!(scan_url("invalid url").is_err());
    }

    #[test]
    fn rejects_unsupported_scheme() {
        assert!(scan_url("file:///etc/passwd").is_err());
    }

    #[test]
    fn rejects_partial_domain_match() {
        let entries = vec![ThreatEntry {
            domain: "malware.example".into(),
            category: "test".into(),
            severity: 90,
            description: "Synthetic test".into(),
        }];

        assert!(match_domain("notmalware.example", &entries).is_none());
    }

    #[test]
    fn matches_subdomain() {
        let entries = vec![ThreatEntry {
            domain: "malware.example".into(),
            category: "test".into(),
            severity: 90,
            description: "Synthetic test".into(),
        }];

        assert!(match_domain("login.malware.example", &entries).is_some());
    }
}
