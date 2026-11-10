
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const HISTORY_KEY = "rayx-shield-history-v1";
const MAX_APK_SIZE = 200 * 1024 * 1024;

const NAV_ITEMS = [
  { id: "overview", icon: "▦", label: "Home" },
  { id: "scanner", icon: "⌕", label: "Scan" },
  { id: "optimize", icon: "⌁", label: "Optimize" },
  { id: "privacy", icon: "◈", label: "Privacy" },
  { id: "settings", icon: "⚙", label: "Settings" },
];

const SCAN_ITEMS = [
  { id: "url", icon: "⌕", label: "URL Scanner" },
  { id: "apk", icon: "▣", label: "APK Scanner" },
  { id: "history", icon: "◷", label: "History" },
];

function readHistory() {
  try {
    const saved = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function formatDate(value) {
  if (!value) return "Unknown";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "Unknown";

  return date.toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "Unavailable";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function createId() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function riskLabel(level) {
  if (!level) return "Unknown";
  return String(level).charAt(0).toUpperCase() + String(level).slice(1);
}

function App() {
  const [page, setPage] = useState("overview");
  const [scanView, setScanView] = useState("url");
  const [engine, setEngine] = useState("checking");

  // URL scanner
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  // APK scanner
  const [apkFile, setApkFile] = useState(null);
  const [apkLoading, setApkLoading] = useState(false);
  const [apkResult, setApkResult] = useState(null);
  const [apkError, setApkError] = useState("");

  // Dashboard
  const [history, setHistory] = useState(readHistory);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [toast, setToast] = useState("");

  // Browser diagnostics
  const [diagnostics, setDiagnostics] = useState({
    loading: false,
    checkedAt: null,
    online: null,
    secure: null,
    memory: null,
    cores: null,
    connection: "Unavailable",
    storageUsage: null,
    storageQuota: null,
    storagePercent: null,
  });

  const notify = useCallback((message) => {
    setToast(message);

    window.clearTimeout(notify.timeout);

    notify.timeout = window.setTimeout(() => {
      setToast("");
    }, 2800);
  }, []);

 
  // Engine health — live polling
  const checkEngine = useCallback(async () => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch("/api/health", {
        signal: controller.signal,
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Engine returned HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.status !== "online") {
        throw new Error("Engine is not online");
      }

      setEngine("online");
    } catch {
      setEngine("offline");
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  useEffect(() => {
    checkEngine();

    const interval = window.setInterval(checkEngine, 5000);

    return () => window.clearInterval(interval);
  }, [checkEngine]);


  // Save history locally
  useEffect(() => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
    } catch {
      notify("Unable to save history in browser storage");
    }
  }, [history, notify]);

  // Browser and device diagnostics
  const runDiagnostics = useCallback(async () => {
    setDiagnostics((previous) => ({
      ...previous,
      loading: true,
    }));

    try {
      let storage = null;

      if (navigator.storage?.estimate) {
        storage = await navigator.storage.estimate();
      }

      const usage = Number.isFinite(storage?.usage)
        ? storage.usage
        : null;

      const quota = Number.isFinite(storage?.quota)
        ? storage.quota
        : null;

      const connection =
        navigator.connection ||
        navigator.mozConnection ||
        navigator.webkitConnection;

      setDiagnostics({
        loading: false,
        checkedAt: new Date().toISOString(),
        online: navigator.onLine,
        secure: window.isSecureContext,
        memory: Number.isFinite(navigator.deviceMemory)
          ? navigator.deviceMemory
          : null,
        cores: Number.isFinite(navigator.hardwareConcurrency)
          ? navigator.hardwareConcurrency
          : null,
        connection: connection?.effectiveType || "Unavailable",
        storageUsage: usage,
        storageQuota: quota,
        storagePercent:
          usage !== null && quota > 0
            ? Math.min(Math.round((usage / quota) * 100), 100)
            : null,
      });

      notify("Diagnostics completed");
    } catch {
      setDiagnostics((previous) => ({
        ...previous,
        loading: false,
        checkedAt: new Date().toISOString(),
      }));

      notify("Some browser diagnostics are unavailable");
    }
  }, [notify]);

  useEffect(() => {
    if (page === "optimize" || page === "privacy") {
      runDiagnostics();
    }
  }, [page, runDiagnostics]);

  // Dashboard statistics
  const stats = useMemo(() => {
    const flagged = history.filter((item) => item.score >= 20).length;

    const average = history.length
      ? Math.round(
          history.reduce((sum, item) => sum + (item.score || 0), 0) /
            history.length
        )
      : 0;

    return {
      total: history.length,
      flagged,
      average,
    };
  }, [history]);

  // URL scanning
  const scan = async (event) => {
    event?.preventDefault();

    const target = url.trim();

    if (!target) return;

    try {
      const parsed = new URL(target);

      if (!["http:", "https:"].includes(parsed.protocol)) {
        notify("Only HTTP and HTTPS URLs are supported");
        return;
      }
    } catch {
      notify("Enter a valid URL including https://");
      return;
    }

    if (engine !== "online") {
      notify("Detection engine is unavailable");
      return;
    }

    setLoading(true);
    setResult(null);

    try {
      const response = await fetch("/api/scan", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ url: target }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Scan request failed");
      }

      const item = {
        id: createId(),
        url: data.normalized_url,
        domain: data.domain,
        score: data.risk_score,
        level: data.risk_level,
        reputation: data.reputation,
        detection: data.detection,
        confidence: data.confidence,
        findings: data.findings,
        note: data.verdict_note,
        createdAt: new Date().toISOString(),
      };

      setResult(item);
      setHistory((previous) => [item, ...previous].slice(0, 500));

      notify("URL scan completed");
    } catch (error) {
      setResult({
        error: error.message || "URL scan failed",
      });

      notify(error.message || "URL scan failed");
    } finally {
      setLoading(false);
    }
  };

  // APK selection
  const handleApkSelection = (event) => {
    const file = event.target.files?.[0] || null;

    setApkFile(null);
    setApkResult(null);
    setApkError("");

    if (!file) return;

    if (!file.name.toLowerCase().endsWith(".apk")) {
      setApkError("Please select a valid .apk file.");
      event.target.value = "";
      return;
    }

    if (file.size === 0) {
      setApkError("The selected APK file is empty.");
      event.target.value = "";
      return;
    }

    if (file.size > MAX_APK_SIZE) {
      setApkError("APK size exceeds the 200 MB limit.");
      event.target.value = "";
      return;
    }

    setApkFile(file);
  };

  // APK scanning through Rust API
  const scanApk = async () => {
    if (!apkFile) {
      setApkError("Select an APK file first.");
      return;
    }

    if (engine !== "online") {
      setApkError("Detection engine is unavailable.");
      return;
    }

    setApkLoading(true);
    setApkError("");
    setApkResult(null);

    try {
      const response = await fetch("/api/scan-apk", {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.android.package-archive",
        },
        body: apkFile,
      });

      const data = await response.json().catch(() => ({
        error: "The server returned an invalid response.",
      }));

      if (!response.ok) {
        throw new Error(data.error || `APK scan failed (${response.status})`);
      }

      setApkResult(data);
      notify("APK analysis completed");
    } catch (error) {
      setApkError(error.message || "APK scan failed.");
      notify(error.message || "APK scan failed.");
    } finally {
      setApkLoading(false);
    }
  };

  // Filter history
  const filteredHistory = useMemo(() => {
    return history.filter((item) => {
      const term = search.toLowerCase();

      const matchesSearch =
        item.url?.toLowerCase().includes(term) ||
        item.domain?.toLowerCase().includes(term);

      const matchesFilter =
        filter === "all" ||
        (filter === "flagged" && item.score >= 20) ||
        (filter === "low" && item.score < 20);

      return matchesSearch && matchesFilter;
    });
  }, [history, search, filter]);

  // Export history
  const exportHistory = () => {
    const blob = new Blob([JSON.stringify(history, null, 2)], {
      type: "application/json",
    });

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = "rayx-shield-scan-history.json";
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(objectUrl);

    notify("History exported");
  };

  // Clear history
  const clearHistory = () => {
    if (!window.confirm("Delete all locally saved scan history?")) return;

    setHistory([]);
    setResult(null);

    notify("Scan history cleared");
  };

  // Navigation helpers
  const openScan = (view = "url") => {
    setScanView(view);
    setPage("scanner");
  };

  const openHistoryItem = (item) => {
    setResult(item);
    setUrl(item.url || "");
    openScan("url");
  };

  const activePage = NAV_ITEMS.find((item) => item.id === page);

  return (
    <div className="shell">
      {/* SIDEBAR */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">R</div>

          <div>
            <strong>
              RAYX<span> SHIELD</span>
            </strong>
            <small>SECURITY SYSTEM</small>
          </div>
        </div>

        <div className="side-label">WORKSPACE</div>

        <nav className="navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? "active" : ""}`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}

              {page === item.id && (
                <span className="nav-indicator" />
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="engine-card">
            <div className="engine-card-top">
              <span className={`engine-dot ${engine}`} />
              <span>Detection engine</span>
            </div>

            <strong>
              {engine === "online"
                ? "Operational"
                : engine === "checking"
                  ? "Checking..."
                  : "Disconnected"}
            </strong>

            <small>Local Rust service · Port 8787</small>

            <button onClick={checkEngine}>
              Refresh status ↻
            </button>
          </div>

          <div className="sidebar-footer">
            <span>RAYX SHIELD</span>
            <span>VERSION 0.8.0</span>
          </div>
        </div>
      </aside>

      {/* MAIN */}
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            <span>RayX Shield</span>
            <span className="crumb-separator">/</span>
            <strong>{activePage?.label || "Home"}</strong>
          </div>

          <div className="topbar-right">
            <span className="local-label">LOCAL ENVIRONMENT</span>

            <div className={`top-status ${engine}`}>
              <span className="engine-dot" />

              {engine === "online"
                ? "Engine online"
                : engine === "checking"
                  ? "Checking engine"
                  : "Engine offline"}
            </div>
          </div>
        </header>

        <div className="content" key={page}>
          {/* HOME */}
          {page === "overview" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">SECURITY WORKSPACE / 01</span>
                  <h1>
                    Overview<span>.</span>
                  </h1>
                  <p>Your local security analysis at a glance.</p>
                </div>

                <button
                  className="primary-button"
                  onClick={() => openScan("url")}
                >
                  <span>＋</span> New scan
                </button>
              </section>

              <section className="welcome-panel">
                <div className="welcome-copy">
                  <span className="eyebrow light">
                    RAYX DETECTION SYSTEM
                  </span>

                  <h2>
                    Stay aware.
                    <br />
                    Browse with care.
                  </h2>

                  <p>
                    Analyze website URLs and Android APK manifests
                    using your local security engine.
                  </p>

                  <button
                    className="light-button"
                    onClick={() => openScan("url")}
                  >
                    Open URL scanner <span>↗</span>
                  </button>

                  <button
                    className="light-button"
                    onClick={() => openScan("apk")}
                    style={{ marginLeft: 10 }}
                  >
                    Open APK scanner <span>↗</span>
                  </button>
                </div>

                <div className="welcome-art" aria-hidden="true">
                  <div className="orbit orbit-one" />
                  <div className="orbit orbit-two" />
                  <div className="orbit orbit-three" />
                  <div className="orbit-core">R</div>
                  <span className="orbit-caption">
                    LOCAL
                    <br />
                    ANALYSIS
                  </span>
                </div>

                <div className="panel-index">01 — 05</div>
              </section>

              <section className="stats-grid">
                <article className="stat-card">
                  <span className="stat-label">TOTAL URL SCANS</span>
                  <strong>{stats.total}</strong>
                  <small>Saved in this browser</small>
                  <span className="stat-symbol">↗</span>
                </article>

                <article className="stat-card">
                  <span className="stat-label">FLAGGED RESULTS</span>
                  <strong>{stats.flagged}</strong>
                  <small>Risk score of 20 or above</small>
                  <span className="stat-symbol warning-symbol">!</span>
                </article>

                <article className="stat-card">
                  <span className="stat-label">AVERAGE RISK SCORE</span>
                  <strong>
                    {stats.average}
                    <i>/100</i>
                  </strong>
                  <small>Across saved URL scans</small>
                  <span className="stat-symbol">⌁</span>
                </article>
              </section>

              <section className="section-block">
                <div className="section-title">
                  <div>
                    <span className="eyebrow">ACTIVITY</span>
                    <h2>Recent scans</h2>
                  </div>

                  <button
                    className="text-button"
                    onClick={() => openScan("history")}
                  >
                    View all <span>→</span>
                  </button>
                </div>

                <HistoryTable
                  items={history.slice(0, 5)}
                  onSelect={openHistoryItem}
                />
              </section>
            </>
          )}

          {/* SCAN SUBNAV */}
          {page === "scanner" && (
            <div className="scan-subnav">
              {SCAN_ITEMS.map((item) => (
                <button
                  key={item.id}
                  className={scanView === item.id ? "active" : ""}
                  onClick={() => setScanView(item.id)}
                >
                  <span>{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}

          {/* URL SCANNER */}
          {page === "scanner" && scanView === "url" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">SECURITY TOOLS / 02</span>
                  <h1>
                    URL Scanner<span>.</span>
                  </h1>
                  <p>
                    Inspect a website address using the local detection engine.
                  </p>
                </div>

                <div className={`engine-pill ${engine}`}>
                  <span className="engine-dot" />
                  {engine === "online"
                    ? "Ready to scan"
                    : "Engine unavailable"}
                </div>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">⌕</div>

                  <div>
                    <h2>Website inspection</h2>
                    <p>Enter the complete URL, including its protocol.</p>
                  </div>
                </div>

                <form className="scanner-form" onSubmit={scan}>
                  <label htmlFor="scan-url">WEBSITE URL</label>

                  <div className="input-wrap">
                    <span>↗</span>

                    <input
                      id="scan-url"
                      type="url"
                      placeholder="https://example.com"
                      value={url}
                      onChange={(event) => setUrl(event.target.value)}
                      required
                    />

                    {url && (
                      <button
                        type="button"
                        onClick={() => setUrl("")}
                      >
                        ×
                      </button>
                    )}
                  </div>

                  <div className="scanner-actions">
                    <span>
                      Analysis runs through your local Rust engine.
                    </span>

                    <button
                      className="primary-button"
                      disabled={loading || engine !== "online"}
                    >
                      {loading ? (
                        <>
                          <span className="spinner" /> Scanning
                        </>
                      ) : (
                        "Run security scan →"
                      )}
                    </button>
                  </div>
                </form>

                {loading && (
                  <div className="scan-progress">
                    <div className="scan-progress-bar" />
                    <span>Analyzing URL indicators...</span>
                  </div>
                )}
              </section>

              {result && (
                <section className="result-panel">
                  {result.error ? (
                    <div className="error-message">
                      <strong>Scan could not be completed</strong>
                      <p>{result.error}</p>
                    </div>
                  ) : (
                    <>
                      <div className="result-top">
                        <div>
                          <span className="eyebrow">ANALYSIS REPORT</span>
                          <h2>{result.domain}</h2>
                          <p className="result-url">{result.url}</p>
                        </div>

                        <span className={`risk-tag ${result.level}`}>
                          {riskLabel(result.level)}
                        </span>
                      </div>

                      <div className="score-layout">
                        <div className="score-number">
                          <strong>{result.score}</strong>
                          <span>RISK SCORE / 100</span>
                        </div>

                        <div className="score-track">
                          <div
                            className={`score-fill ${result.level}`}
                            style={{
                              width: `${Math.min(result.score || 0, 100)}%`,
                            }}
                          />
                        </div>
                      </div>

                      <div className="result-metadata">
                        <div>
                          <span>Reputation</span>
                          <strong>{result.reputation || "Unknown"}</strong>
                        </div>

                        <div>
                          <span>Detection</span>
                          <strong>{result.detection || "Unknown"}</strong>
                        </div>

                        <div>
                          <span>Confidence</span>
                          <strong>{result.confidence || "Unknown"}</strong>
                        </div>
                      </div>

                      <div className="findings">
                        <h3>
                          Detection findings
                          <span>{result.findings?.length || 0}</span>
                        </h3>

                        {result.findings?.length ? (
                          result.findings.map((finding, index) => (
                            <div className="finding-row" key={index}>
                              <span className="finding-marker">—</span>
                              {finding}
                            </div>
                          ))
                        ) : (
                          <div className="finding-row">
                            No findings returned.
                          </div>
                        )}
                      </div>

                      <p className="result-disclaimer">{result.note}</p>
                    </>
                  )}
                </section>
              )}

              {!result && (
                <div className="scanner-guidance">
                  <span className="guidance-icon">i</span>
                  <p>
                    An unknown reputation is not proof that a website is safe.
                    A URL scan does not replace browser or device protection.
                  </p>
                </div>
              )}
            </>
          )}

          {/* APK SCANNER */}
          {page === "scanner" && scanView === "apk" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">SECURITY TOOLS / 03</span>
                  <h1>
                    APK Scanner<span>.</span>
                  </h1>
                  <p>
                    Analyze an Android application package using static
                    manifest checks.
                  </p>
                </div>

                <div className={`engine-pill ${engine}`}>
                  <span className="engine-dot" />
                  {engine === "online"
                    ? "Ready to scan"
                    : "Engine unavailable"}
                </div>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">▣</div>

                  <div>
                    <h2>Android package inspection</h2>
                    <p>
                      Select an APK file to inspect its manifest and permissions.
                    </p>
                  </div>
                </div>

                <div className="scanner-form">
                  <label htmlFor="apk-file">ANDROID APK FILE</label>

                  <div className="input-wrap">
                    <input
                      id="apk-file"
                      type="file"
                      accept=".apk,application/vnd.android.package-archive"
                      onChange={handleApkSelection}
                      disabled={apkLoading}
                    />
                  </div>

                  {apkFile && (
                    <div className="scanner-guidance">
                      <span className="guidance-icon">✓</span>
                      <p>
                        <strong>{apkFile.name}</strong>
                        <br />
                        File size: {formatBytes(apkFile.size)}
                      </p>
                    </div>
                  )}

                  <div className="scanner-actions">
                    <span>Maximum file size: 200 MB.</span>

                    <button
                      type="button"
                      className="primary-button"
                      onClick={scanApk}
                      disabled={
                        !apkFile ||
                        apkLoading ||
                        engine !== "online"
                      }
                    >
                      {apkLoading ? (
                        <>
                          <span className="spinner" /> Analyzing APK
                        </>
                      ) : (
                        "Run APK scan →"
                      )}
                    </button>
                  </div>

                  {apkLoading && (
                    <div className="scan-progress">
                      <div className="scan-progress-bar" />
                      <span>
                        Reading APK archive and analyzing manifest...
                      </span>
                    </div>
                  )}

                  {apkError && (
                    <div className="error-message" role="alert">
                      <strong>APK scan could not be completed</strong>
                      <p>{apkError}</p>
                    </div>
                  )}
                </div>
              </section>

              {apkResult && (
                <section className="result-panel">
                  <div className="result-top">
                    <div>
                      <span className="eyebrow">APK ANALYSIS REPORT</span>

                      <h2>
                        {apkResult.file_name ||
                          apkFile?.name ||
                          "Android APK"}
                      </h2>

                      <p className="result-url">
                        {apkResult.package_name ||
                          "Package name unavailable"}
                      </p>
                    </div>

                    <span className={`risk-tag ${apkResult.risk_level}`}>
                      {riskLabel(apkResult.risk_level)}
                    </span>
                  </div>

                  <div className="score-layout">
                    <div className="score-number">
                      <strong>{apkResult.risk_score ?? 0}</strong>
                      <span>RISK SCORE / 100</span>
                    </div>

                    <div className="score-track">
                      <div
                        className={`score-fill ${apkResult.risk_level}`}
                        style={{
                          width: `${Math.min(
                            apkResult.risk_score || 0,
                            100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div className="result-metadata">
                    <div>
                      <span>File size</span>
                      <strong>{formatBytes(apkResult.file_size)}</strong>
                    </div>

                    <div>
                      <span>Detection</span>
                      <strong>{apkResult.detection || "Unknown"}</strong>
                    </div>

                    <div>
                      <span>Confidence</span>
                      <strong>{apkResult.confidence || "Unknown"}</strong>
                    </div>
                  </div>

                  <div className="findings">
                    <h3>SHA-256</h3>
                    <div
                      className="finding-row"
                      style={{ wordBreak: "break-all" }}
                    >
                      {apkResult.sha256 || "Not available"}
                    </div>
                  </div>

                  <div className="findings">
                    <h3>
                      Android permissions
                      <span>{apkResult.permissions?.length || 0}</span>
                    </h3>

                    {apkResult.permissions?.length ? (
                      apkResult.permissions.map((permission, index) => (
                        <div
                          className="finding-row"
                          key={`${permission}-${index}`}
                        >
                          <span className="finding-marker">—</span>
                          <span style={{ wordBreak: "break-word" }}>
                            {permission}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="finding-row">
                        No permissions were extracted.
                      </div>
                    )}
                  </div>

                  <div className="findings">
                    <h3>
                      Detection findings
                      <span>{apkResult.findings?.length || 0}</span>
                    </h3>

                    {apkResult.findings?.length ? (
                      apkResult.findings.map((finding, index) => (
                        <div className="finding-row" key={index}>
                          <span className="finding-marker">—</span>
                          {finding}
                        </div>
                      ))
                    ) : (
                      <div className="finding-row">
                        No findings were returned.
                      </div>
                    )}
                  </div>

                  <p className="result-disclaimer">
                    {apkResult.verdict_note ||
                      "Static manifest analysis only. This result does not guarantee that an APK is safe."}
                  </p>
                </section>
              )}

              {!apkResult && !apkError && (
                <div className="scanner-guidance">
                  <span className="guidance-icon">i</span>
                  <p>
                    This scanner performs static APK manifest analysis.
                    It does not execute the app or perform complete malware
                    detection. A low risk score does not guarantee an APK is safe.
                  </p>
                </div>
              )}
            </>
          )}

          {/* SCAN HISTORY */}
          {page === "scanner" && scanView === "history" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">SECURITY RECORDS / 04</span>
                  <h1>
                    Scan history<span>.</span>
                  </h1>
                  <p>
                    Review and manage URL scans saved in this browser.
                  </p>
                </div>

                <button
                  className="secondary-button"
                  onClick={exportHistory}
                  disabled={!history.length}
                >
                  ↓ Export JSON
                </button>
              </section>

              <section className="history-panel">
                <div className="history-toolbar">
                  <div className="search-box">
                    <span>⌕</span>

                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search domain or URL..."
                    />
                  </div>

                  <select
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    <option value="all">All scans</option>
                    <option value="flagged">Flagged</option>
                    <option value="low">Low score</option>
                  </select>
                </div>

                <HistoryTable
                  items={filteredHistory}
                  onSelect={openHistoryItem}
                  showDate
                />

                <div className="history-footer">
                  <span>
                    {filteredHistory.length} of {history.length} records
                  </span>

                  <button
                    className="danger-button"
                    onClick={clearHistory}
                    disabled={!history.length}
                  >
                    Clear history
                  </button>
                </div>
              </section>
            </>
          )}

          {/* OPTIMIZE */}
          {page === "optimize" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">DEVICE INTELLIGENCE / 03</span>
                  <h1>
                    Optimize<span>.</span>
                  </h1>
                  <p>
                    Inspect browser resources and available device capabilities.
                  </p>
                </div>

                <button
                  className="primary-button"
                  onClick={runDiagnostics}
                  disabled={diagnostics.loading}
                >
                  {diagnostics.loading
                    ? "Checking..."
                    : "↻ Run diagnostics"}
                </button>
              </section>

              <section className="stats-grid">
                <article className="stat-card">
                  <span className="stat-label">CONNECTION</span>

                  <strong>
                    {diagnostics.online === null
                      ? "—"
                      : diagnostics.online
                        ? "Online"
                        : "Offline"}
                  </strong>

                  <small>Browser network status</small>
                  <span className="stat-symbol">⌁</span>
                </article>

                <article className="stat-card">
                  <span className="stat-label">MEMORY HINT</span>

                  <strong>
                    {diagnostics.memory === null
                      ? "N/A"
                      : `${diagnostics.memory} GB`}
                  </strong>

                  <small>Browser-reported approximate value</small>
                  <span className="stat-symbol">▤</span>
                </article>

                <article className="stat-card">
                  <span className="stat-label">CPU THREAD HINT</span>
                  <strong>{diagnostics.cores ?? "N/A"}</strong>
                  <small>Reported logical processors</small>
                  <span className="stat-symbol">◈</span>
                </article>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">▤</div>

                  <div>
                    <h2>Browser storage usage</h2>
                    <p>
                      Storage estimate for this website's browser origin.
                    </p>
                  </div>
                </div>

                <div className="score-layout">
                  <div className="score-number">
                    <strong>{diagnostics.storagePercent ?? "—"}%</strong>
                    <span>ESTIMATED USAGE</span>
                  </div>

                  <div className="score-track">
                    <div
                      className="score-fill"
                      style={{
                        width: `${diagnostics.storagePercent ?? 0}%`,
                      }}
                    />
                  </div>
                </div>

                <div className="result-metadata">
                  <div>
                    <span>Used</span>
                    <strong>
                      {formatBytes(diagnostics.storageUsage)}
                    </strong>
                  </div>

                  <div>
                    <span>Estimated quota</span>
                    <strong>
                      {formatBytes(diagnostics.storageQuota)}
                    </strong>
                  </div>

                  <div>
                    <span>Connection type</span>
                    <strong>{diagnostics.connection}</strong>
                  </div>
                </div>
              </section>

              <section className="scanner-guidance">
                <span className="guidance-icon">i</span>

                <p>
                  These are browser-level diagnostics, not a complete device
                  scan. They cannot clean phone RAM, remove system junk,
                  inspect all installed apps or guarantee better battery life.
                  Native Android integration will provide additional
                  supported device information.
                </p>
              </section>

              <p className="result-disclaimer">
                Last checked:{" "}
                {diagnostics.checkedAt
                  ? formatDate(diagnostics.checkedAt)
                  : "Not checked yet"}
              </p>
            </>
          )}

          {/* PRIVACY */}
          {page === "privacy" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">PRIVACY INTELLIGENCE / 04</span>
                  <h1>
                    Privacy<span>.</span>
                  </h1>
                  <p>
                    Review basic browser security and privacy indicators.
                  </p>
                </div>

                <button
                  className="secondary-button"
                  onClick={runDiagnostics}
                  disabled={diagnostics.loading}
                >
                  ↻ Refresh checks
                </button>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">◈</div>

                  <div>
                    <h2>Privacy checks</h2>
                    <p>
                      Live checks based on browser-exposed information.
                    </p>
                  </div>
                </div>

                <div
                  className="result-metadata"
                  style={{ marginTop: 22 }}
                >
                  <div>
                    <span>Secure context</span>
                    <strong>
                      {diagnostics.secure === null
                        ? "Checking..."
                        : diagnostics.secure
                          ? "Secure"
                          : "Not secure"}
                    </strong>
                  </div>

                  <div>
                    <span>Network connectivity</span>
                    <strong>
                      {diagnostics.online === null
                        ? "Checking..."
                        : diagnostics.online
                          ? "Connected"
                          : "Disconnected"}
                    </strong>
                  </div>

                  <div>
                    <span>Connection type</span>
                    <strong>{diagnostics.connection}</strong>
                  </div>
                </div>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">✓</div>

                  <div>
                    <h2>Privacy recommendations</h2>
                    <p>Practical checks you can perform in your browser.</p>
                  </div>
                </div>

                <div className="finding-row">
                  <span className="finding-marker">01</span>
                  Use HTTPS websites when entering personal information.
                </div>

                <div className="finding-row">
                  <span className="finding-marker">02</span>
                  Review camera, microphone and location permissions in browser settings.
                </div>

                <div className="finding-row">
                  <span className="finding-marker">03</span>
                  Keep your browser and operating system updated.
                </div>

                <div className="finding-row">
                  <span className="finding-marker">04</span>
                  Avoid installing applications from untrusted sources.
                </div>
              </section>

              <section className="scanner-guidance">
                <span className="guidance-icon">i</span>

                <p>
                  These checks do not inspect your browsing history, installed
                  apps, passwords or other private browser data. A secure
                  context alone does not establish that a website is trustworthy.
                </p>
              </section>
            </>
          )}

          {/* SETTINGS */}
          {page === "settings" && (
            <>
              <section className="page-heading">
                <div>
                  <span className="eyebrow">SYSTEM CONFIGURATION / 05</span>
                  <h1>
                    Settings<span>.</span>
                  </h1>
                  <p>
                    Manage your local RayX Shield dashboard.
                  </p>
                </div>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">⚙</div>

                  <div>
                    <h2>Detection engine</h2>
                    <p>Local Rust security service.</p>
                  </div>
                </div>

                <div
                  className="result-metadata"
                  style={{ marginTop: 22 }}
                >
                  <div>
                    <span>Engine status</span>
                    <strong>{engine.toUpperCase()}</strong>
                  </div>

                  <div>
                    <span>Service</span>
                    <strong>127.0.0.1:8787</strong>
                  </div>

                  <div>
                    <span>Dashboard</span>
                    <strong>Version 0.8.0</strong>
                  </div>
                </div>

                <div className="scanner-actions">
                  <span>Check the local engine connection.</span>

                  <button
                    className="secondary-button"
                    onClick={checkEngine}
                  >
                    Refresh engine ↻
                  </button>
                </div>
              </section>

              <section className="scanner-panel">
                <div className="scanner-panel-heading">
                  <div className="scanner-icon">◷</div>

                  <div>
                    <h2>Scan history management</h2>
                    <p>
                      Your URL scan history is stored locally in this browser.
                    </p>
                  </div>
                </div>

                <div className="scanner-actions">
                  <span>{history.length} saved records</span>

                  <button
                    className="secondary-button"
                    onClick={exportHistory}
                    disabled={!history.length}
                  >
                    Export history ↓
                  </button>
                </div>

                <div className="scanner-actions">
                  <span>Remove locally saved scan records.</span>

                  <button
                    className="danger-button"
                    onClick={clearHistory}
                    disabled={!history.length}
                  >
                    Clear history
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <footer className="main-footer">
          <span>RAYX SHIELD © 2026</span>
          <span>
            BUILT FOR A SAFER WEB <i>·</i> BY RAJAN
          </span>
        </footer>
      </main>

      {/* MOBILE NAVIGATION */}
      <nav className="mobile-nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            className={page === item.id ? "active" : ""}
            onClick={() => setPage(item.id)}
          >
            <span>{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>

      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  );
}

// HISTORY TABLE
function HistoryTable({ items, onSelect, showDate = false }) {
  if (!items.length) {
    return (
      <div className="empty-state">
        <span>◷</span>
        <strong>No scan records yet</strong>
        <p>Completed URL scans will appear here.</p>
      </div>
    );
  }

  return (
    <div className="table-wrap">
      <table className="scan-table">
        <thead>
          <tr>
            <th>WEBSITE</th>
            <th>RISK SCORE</th>
            <th>VERDICT</th>
            {showDate && <th>DATE</th>}
            <th></th>
          </tr>
        </thead>

        <tbody>
          {items.map((item) => (
            <tr
              key={item.id}
              onClick={() => onSelect(item)}
            >
              <td>
                <strong>{item.domain || item.url}</strong>
                <small>{item.url}</small>
              </td>

              <td>
                <strong>
                  {item.score}
                  <span className="muted-score"> / 100</span>
                </strong>
              </td>

              <td>
                <span className={`risk-tag ${item.level}`}>
                  {riskLabel(item.level)}
                </span>
              </td>

              {showDate && (
                <td className="date-cell">
                  {formatDate(item.createdAt)}
                </td>
              )}

              <td>
                <button
                  type="button"
                  className="row-action"
                  aria-label="View scan"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(item);
                  }}
                >
                  ↗
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default App;
