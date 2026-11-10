
use rayx_shield_engine::{scan_url, update_feed};
use serde::Deserialize;
use std::{
    env,
    io::Read,
    process,
    thread,
    time::Duration,
};
use tiny_http::{Header, Request, Response, Server, StatusCode};

const MAX_APK_SIZE: u64 = 200 * 1024 * 1024;

#[derive(Deserialize)]
struct ScanRequest {
    url: String,
}

fn get_feed_url() -> String {
    match env::var("RAYX_FEED_URL") {
        Ok(url) if !url.trim().is_empty() => url,
        _ => {
            eprintln!("RAYX_FEED_URL is not configured.");
            process::exit(1);
        }
    }
}

fn refresh_feed(url: &str) {
    match update_feed(url) {
        Ok(count) => println!(
            "[RayX Shield] Feed updated: {} domains",
            count
        ),
        Err(error) => {
            eprintln!("[RayX Shield] Update failed: {}", error);
            eprintln!("[RayX Shield] Existing database preserved.");
        }
    }
}

fn respond_json(request: Request, status: u16, body: String) {
    let header = Header::from_bytes(
        &b"Content-Type"[..],
        &b"application/json; charset=utf-8"[..],
    )
    .unwrap();

    let response = Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(header);

    if let Err(error) = request.respond(response) {
        eprintln!("Response error: {}", error);
    }
}

fn start_server() {
    let server = match Server::http("127.0.0.1:8787") {
        Ok(server) => server,
        Err(error) => {
            eprintln!("Could not start server: {}", error);
            process::exit(1);
        }
    };

    println!("RayX Shield API v0.6.0");
    println!("Listening at http://127.0.0.1:8787");
    println!("Available endpoints:");
    println!("GET  /health");
    println!("POST /scan");
    println!("POST /scan-apk");
    println!("Press Ctrl+C to stop.");

    for mut request in server.incoming_requests() {
        let path = request.url().to_string();
        let method = request.method().as_str().to_string();

        // Health check
        if method == "GET" && path == "/health" {
            respond_json(
                request,
                200,
                r#"{"status":"online","service":"RayX Shield"}"#.into(),
            );
            continue;
        }

        // APK static analysis
        if method == "POST" && path == "/scan-apk" {
            let mut body = Vec::new();

            let read_result = request
                .as_reader()
                .take(MAX_APK_SIZE + 1)
                .read_to_end(&mut body);

            if read_result.is_err() {
                respond_json(
                    request,
                    400,
                    r#"{"error":"Could not read APK upload"}"#.into(),
                );
                continue;
            }

            if body.is_empty() {
                respond_json(
                    request,
                    400,
                    r#"{"error":"APK file is empty"}"#.into(),
                );
                continue;
            }

            if body.len() as u64 > MAX_APK_SIZE {
                respond_json(
                    request,
                    413,
                    r#"{"error":"APK exceeds 200 MB limit"}"#.into(),
                );
                continue;
            }

            match rayx_shield_engine::apk::scan_apk(
                &body,
                "uploaded.apk",
            ) {
                Ok(report) => {
                    let json = serde_json::to_string_pretty(&report)
                        .unwrap_or_else(|_| {
                            r#"{"error":"Serialization failed"}"#.into()
                        });

                    respond_json(request, 200, json);
                }

                Err(error) => {
                    let json = serde_json::json!({
                        "error": error
                    })
                    .to_string();

                    respond_json(request, 400, json);
                }
            }

            continue;
        }

        // Existing URL scanner
        if method == "POST" && path == "/scan" {
            let mut body = String::new();

            let read_result = request
                .as_reader()
                .take(16_384)
                .read_to_string(&mut body);

            if read_result.is_err() {
                respond_json(
                    request,
                    400,
                    r#"{"error":"Could not read request"}"#.into(),
                );
                continue;
            }

            let scan_request: ScanRequest =
                match serde_json::from_str(&body) {
                    Ok(data) => data,
                    Err(_) => {
                        respond_json(
                            request,
                            400,
                            r#"{"error":"Invalid JSON. Expected {\"url\":\"https://example.com\"}"}"#.into(),
                        );
                        continue;
                    }
                };

            match scan_url(&scan_request.url) {
                Ok(report) => {
                    let json = serde_json::to_string_pretty(&report)
                        .unwrap_or_else(|_| {
                            r#"{"error":"Serialization failed"}"#.into()
                        });

                    respond_json(request, 200, json);
                }

                Err(error) => {
                    let json = serde_json::json!({
                        "error": error
                    })
                    .to_string();

                    respond_json(request, 400, json);
                }
            }

            continue;
        }

        respond_json(
            request,
            404,
            r#"{"error":"Route not found"}"#.into(),
        );
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.len() < 2 {
        println!("RayX Shield v0.6.0");
        println!("Commands:");
        println!("  cargo run -- <URL>");
        println!("  cargo run -- update-feed");
        println!("  cargo run -- watch-feed [minutes]");
        println!("  cargo run -- serve");
        return;
    }

    match args[1].as_str() {
        "update-feed" => {
            let url = get_feed_url();
            refresh_feed(&url);
        }

        "watch-feed" => {
            let url = get_feed_url();

            let minutes = args
                .get(2)
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(360)
                .max(5);

            println!("Automatic feed refresh started.");

            loop {
                refresh_feed(&url);
                thread::sleep(Duration::from_secs(minutes * 60));
            }
        }

        "serve" => start_server(),

        _ => match scan_url(&args[1]) {
            Ok(report) => println!(
                "{}",
                serde_json::to_string_pretty(&report)
                    .expect("JSON error")
            ),
            Err(error) => {
                eprintln!("Scan failed: {}", error);
                process::exit(1);
            }
        },
    }
}
