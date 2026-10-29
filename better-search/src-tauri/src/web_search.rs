//! Web search in the search window, through the user's own API key for a
//! search provider (bring your own key). Users without one keep opening
//! searches in a browser. The keys live in Windows Credential Manager, not in
//! settings.json (which the indexer reads too) and not in the pages: the
//! settings page hands a key over once to save it, and every request is made
//! from here.

use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, State};

use crate::settings::{self, SettingsState};

/// Results one search asks for.
const RESULT_COUNT: usize = 10;

struct Provider {
    id: &'static str,
    name: &'static str,
}

/// Keep in step with `PROVIDERS` in src/lib/web-search.ts.
pub const PROVIDERS: [&str; 4] = ["exa", "firecrawl", "tinyfish", "context"];

fn provider(id: &str) -> Result<Provider, String> {
    let (id, name) = match id {
        "exa" => ("exa", "Exa"),
        "firecrawl" => ("firecrawl", "Firecrawl"),
        "tinyfish" => ("tinyfish", "TinyFish"),
        "context" => ("context", "Context.dev"),
        _ => return Err(format!("unknown search provider: {id}")),
    };
    Ok(Provider { id, name })
}

#[derive(Serialize)]
pub struct WebResult {
    title: String,
    url: String,
    snippet: String,
}

/// Whether a provider has a key saved, for the settings page.
#[derive(Serialize)]
pub struct KeyStatus {
    provider: &'static str,
    /// The key's last four characters, to tell keys apart; None when there's
    /// no key.
    hint: Option<String>,
}

fn status(provider: &'static str) -> KeyStatus {
    let hint = vault::read(provider).map(|key| key.chars().skip(key.chars().count().saturating_sub(4)).collect());
    KeyStatus { provider, hint }
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            // Nor through a redirect (see `is_local`).
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() >= 10 {
                    attempt.error("too many redirects")
                } else if is_local(attempt.url()) {
                    attempt.stop()
                } else {
                    attempt.follow()
                }
            }))
            .build()
            .expect("HTTP client")
    })
}

/// Whether `url` points at this machine or the local network. Favicons are
/// fetched from whatever addresses a provider's results name, which shouldn't
/// be able to send requests to the user's router or local services. A public
/// name that resolves to a local address still gets through.
fn is_local(url: &reqwest::Url) -> bool {
    use std::net::IpAddr;

    let Some(host) = url.host_str() else { return true };
    let host = host.trim_start_matches('[').trim_end_matches(']').trim_end_matches('.').to_ascii_lowercase();
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => is_local_v4(ip),
        Ok(IpAddr::V6(ip)) => {
            let first = ip.segments()[0];
            ip.is_loopback()
                || ip.is_unspecified()
                || (first & 0xfe00) == 0xfc00 // unique local
                || (first & 0xffc0) == 0xfe80 // link-local
                || ip.to_ipv4_mapped().is_some_and(is_local_v4)
        }
        // Single-label names ("router", "nas") are on the local network.
        Err(_) => host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") || !host.contains('.'),
    }
}

fn is_local_v4(ip: std::net::Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || (a == 100 && (64..128).contains(&b)) // carrier-grade NAT
}

/// For requests that carry an API key. It never follows a redirect: reqwest
/// only strips Authorization on a cross-origin hop, so an `x-api-key` header
/// would go to wherever a provider (or anyone in between) redirected to.
fn api_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .redirect(reqwest::redirect::Policy::none())
            .https_only(true)
            .build()
            .expect("HTTP client")
    })
}

/// Favicons by site ("https://example.com"), kept across searches and windows.
/// None: the site has none worth showing.
fn favicons() -> &'static Mutex<HashMap<String, Option<Vec<u8>>>> {
    static FAVICONS: OnceLock<Mutex<HashMap<String, Option<Vec<u8>>>>> = OnceLock::new();
    FAVICONS.get_or_init(Default::default)
}

/// Bigger than any favicon; a page's <head>, where its icon links are, comes
/// well within it.
const FAVICON_MAX_BYTES: usize = 256 * 1024;

/// Up to `FAVICON_MAX_BYTES` of `url`, with its content type; None if it
/// doesn't answer 200 in time.
async fn fetch_head(url: &str) -> Option<(String, Vec<u8>)> {
    let mut response = client()
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) BetterSearch")
        .timeout(Duration::from_secs(4))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let kind = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() >= FAVICON_MAX_BYTES {
            body.truncate(FAVICON_MAX_BYTES);
            break;
        }
    }
    Some((kind, body))
}

/// The image's type from its first bytes: servers often send favicons as
/// text/plain or an HTML error page with 200.
fn image_type(bytes: &[u8]) -> Option<&'static str> {
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    match bytes {
        [0, 0, 1, 0, ..] => Some("image/x-icon"),
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xFF, 0xD8, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ if text.contains("<svg") => Some("image/svg+xml"),
        _ => None,
    }
}

/// The href of the page's icon link (rel="icon", "shortcut icon",
/// "apple-touch-icon"), preferring an svg or png one over an .ico.
fn icon_link(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let mut best: Option<(u8, String)> = None;
    for (start, _) in lower.match_indices("<link") {
        let Some(end) = lower[start..].find('>') else { break };
        let tag = &html[start..start + end];
        let attr = |name: &str| {
            let at = tag.to_ascii_lowercase().find(&format!("{name}="))? + name.len() + 1;
            let rest = &tag[at..];
            let (quote, rest) = match rest.chars().next()? {
                q @ ('"' | '\'') => (q, &rest[1..]),
                _ => (' ', rest),
            };
            Some(rest[..rest.find(quote).unwrap_or(rest.len())].trim().to_string())
        };
        let (Some(rel), Some(href)) = (attr("rel"), attr("href")) else { continue };
        if !rel.to_ascii_lowercase().split_whitespace().any(|r| r == "icon" || r == "apple-touch-icon") {
            continue;
        }
        let href_lower = href.to_ascii_lowercase();
        let rank = if href_lower.contains(".svg") || href_lower.contains(".png") { 2 } else { 1 };
        if best.as_ref().is_none_or(|(r, _)| rank > *r) {
            best = Some((rank, href));
        }
    }
    best.map(|(_, href)| href)
}

/// The image at `url`, if it is one.
async fn image_bytes(url: &str) -> Option<Vec<u8>> {
    let (_, body) = fetch_head(url).await?;
    // A cut-off image wouldn't draw.
    if body.len() >= FAVICON_MAX_BYTES {
        return None;
    }
    image_type(&body)?;
    Some(body)
}

async fn find_favicon(site: &reqwest::Url) -> Option<Vec<u8>> {
    if let Some(icon) = image_bytes(site.join("/favicon.ico").ok()?.as_str()).await {
        return Some(icon);
    }
    let (kind, page) = fetch_head(site.as_str()).await?;
    if !kind.contains("html") {
        return None;
    }
    let href = icon_link(&String::from_utf8_lossy(&page))?;
    let icon = site.join(&href).ok()?;
    if !matches!(icon.scheme(), "https" | "http") || is_local(&icon) {
        return None;
    }
    image_bytes(icon.as_str()).await
}

/// The site's own favicon for a result's page, as the image file's bytes (no
/// bytes: none). Asked of the site itself, not a favicon service, so no third
/// party sees the results. Raw bytes rather than a data URL: a third smaller
/// than base64, and the page keeps them as a blob rather than a string.
#[tauri::command]
pub async fn favicon(url: String) -> tauri::ipc::Response {
    tauri::ipc::Response::new(site_favicon(&url).await.unwrap_or_default())
}

async fn site_favicon(url: &str) -> Option<Vec<u8>> {
    let page = reqwest::Url::parse(url).ok()?;
    if !matches!(page.scheme(), "https" | "http") || is_local(&page) {
        return None;
    }
    let site = reqwest::Url::parse(&page.origin().ascii_serialization()).ok()?;
    let key = site.as_str().to_string();
    if let Some(cached) = favicons().lock().unwrap().get(&key) {
        return cached.clone();
    }
    let icon = find_favicon(&site).await;
    let mut cache = favicons().lock().unwrap();
    if cache.len() >= 200 {
        cache.clear();
    }
    cache.insert(key, icon.clone());
    icon
}

/// The JSON a provider answered `request` with, or a message to show.
/// `doing` finishes "couldn't ...", like "search".
async fn send(provider: &Provider, request: reqwest::RequestBuilder, doing: &str) -> Result<Value, String> {
    let response = request.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("{} took too long to answer.", provider.name)
        } else {
            format!("Couldn't reach {}. Check your internet connection.", provider.name)
        }
    })?;
    let status = response.status().as_u16();
    if status != 200 {
        return Err(match status {
            401 => format!("{} didn't accept the API key.", provider.name),
            403 => format!("{} didn't allow this key to {doing}.", provider.name),
            402 => format!("Your {} account is out of credits.", provider.name),
            429 => format!("Too many requests to {} right now. Try again in a moment.", provider.name),
            _ => format!("{} couldn't {doing} (error {status}).", provider.name),
        });
    }
    response
        .json()
        .await
        .map_err(|_| format!("{} sent an answer Better Search couldn't read.", provider.name))
}

/// Searches `query` with `provider`'s API, using `key`. Also gives the
/// search's cost in US dollars when the provider estimates it (Exa).
async fn search(provider: &Provider, key: &str, query: &str, count: usize) -> Result<(Vec<WebResult>, Option<f64>), String> {
    let http = api_client();
    let request = match provider.id {
        "exa" => http
            .post("https://api.exa.ai/search")
            .header("x-api-key", key)
            .json(&json!({ "query": query, "numResults": count, "type": "auto", "contents": { "highlights": true } })),
        "firecrawl" => http
            .post("https://api.firecrawl.dev/v2/search")
            .bearer_auth(key)
            .json(&json!({ "query": query, "limit": count })),
        "tinyfish" => http
            .get("https://api.search.tinyfish.ai")
            .header("X-API-Key", key)
            .query(&[("query", query)]),
        _ => http
            .post("https://api.context.dev/v1/web/search")
            .bearer_auth(key)
            .json(&json!({ "query": query, "numResults": count })),
    };

    let body = send(provider, request, "search").await?;

    // Where each API keeps its results and their snippet.
    let (items, snippet_of): (&Value, fn(&Value) -> &str) = match provider.id {
        "exa" => (&body["results"], |r| r["highlights"][0].as_str().or(r["text"].as_str()).unwrap_or("")),
        "firecrawl" => (&body["data"]["web"], |r| r["description"].as_str().unwrap_or("")),
        "tinyfish" => (&body["results"], |r| r["snippet"].as_str().unwrap_or("")),
        _ => (&body["results"], |r| r["description"].as_str().unwrap_or("")),
    };
    let results = items
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter_map(|r| {
            let url = r["url"].as_str()?;
            // Only pages a browser can open (see `open_url`).
            if !url.starts_with("https://") && !url.starts_with("http://") {
                return None;
            }
            Some(WebResult {
                title: r["title"].as_str().filter(|t| !t.trim().is_empty()).unwrap_or(url).trim().to_string(),
                url: url.to_string(),
                snippet: snippet_of(r).split_whitespace().collect::<Vec<_>>().join(" "),
            })
        })
        .take(count)
        .collect();
    Ok((results, body["costDollars"]["total"].as_f64()))
}

/// The UTC year and month a day (counted from 1970-01-01) falls in.
fn month_of(days: i64) -> (i64, i64) {
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(month <= 2), month)
}

/// This month as "2026-10", and its first moment as RFC 3339.
fn this_month() -> (String, String) {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() / 86_400;
    let (year, month) = month_of(days as i64);
    (format!("{year:04}-{month:02}"), format!("{year:04}-{month:02}-01T00:00:00Z"))
}

/// One provider's searches through Better Search this month, and what they
/// cost as the provider estimated it. Only Exa's is shown: it has no usage
/// API for ordinary keys, while the others report their own.
#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Tally {
    /// "2026-10"
    month: String,
    searches: u64,
    usd: f64,
}

/// The tallies by provider, in usage.json in the app's data folder.
fn tally_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("usage.json"))
}

fn read_tallies(app: &AppHandle) -> HashMap<String, Tally> {
    tally_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn tally(app: &AppHandle, provider: &str) -> Tally {
    let month = this_month().0;
    read_tallies(app)
        .remove(provider)
        .filter(|t| t.month == month)
        .unwrap_or(Tally { month, ..Default::default() })
}

/// Counts a search; a new month starts from zero.
fn record_search(app: &AppHandle, provider: &str, usd: Option<f64>) {
    static WRITING: Mutex<()> = Mutex::new(());
    let _writing = WRITING.lock().unwrap();
    let Some(path) = tally_path(app) else { return };
    let mut tallies = read_tallies(app);
    tallies.insert(provider.to_string(), {
        let mut t = tally(app, provider);
        t.searches += 1;
        t.usd += usd.unwrap_or(0.0);
        t
    });
    let saved = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::write(&path, serde_json::to_string_pretty(&tallies).unwrap_or_default()));
    if let Err(e) = saved {
        tauri_plugin_log::log::warn!("Couldn't save {}: {e}", path.display());
    }
}

/// How much of a provider's allowance the key's account has used, for the
/// settings page.
#[derive(Default, Serialize)]
pub struct Usage {
    /// In `unit`s, over this `period`.
    used: Option<f64>,
    /// Credits left; None when the provider doesn't say.
    left: Option<f64>,
    /// "credits", "searches" or "usd".
    unit: &'static str,
    /// "month" or "billing period".
    period: &'static str,
    /// Counted from Better Search's own searches, not reported by the provider.
    local: bool,
    /// The account's prepaid balance in US dollars (TinyFish's wallet).
    balance_usd: Option<f64>,
}

#[tauri::command]
pub fn api_keys() -> Vec<KeyStatus> {
    PROVIDERS.into_iter().map(status).collect()
}

/// Tries `key` with a one-result search, then saves it. Nothing is saved when
/// the provider turns it down.
#[tauri::command]
pub async fn save_api_key(app: AppHandle, provider: String, key: String) -> Result<KeyStatus, String> {
    let provider = self::provider(&provider)?;
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste a key first.".into());
    }
    let (_, cost) = search(&provider, key, "better search", 1).await?;
    vault::write(provider.id, key)?;
    record_search(&app, provider.id, cost);
    Ok(status(provider.id))
}

/// Forgets the key. Searches that went to this provider go to the browser
/// again.
#[tauri::command]
pub fn remove_api_key(app: AppHandle, state: State<'_, SettingsState>, provider: String) -> Result<KeyStatus, String> {
    let provider = self::provider(&provider)?;
    vault::delete(provider.id)?;
    let current = state.0.lock().unwrap().clone();
    if current.web.provider == provider.id {
        let mut changed = current;
        changed.web.provider = "browser".into();
        settings::update_settings(app, state, changed)?;
    }
    Ok(status(provider.id))
}

#[tauri::command]
pub async fn web_search(app: AppHandle, provider: String, query: String) -> Result<Vec<WebResult>, String> {
    let provider = self::provider(&provider)?;
    let key = vault::read(provider.id).ok_or_else(|| format!("Add your {} key in Settings → API keys.", provider.name))?;
    let (results, cost) = search(&provider, &key, query.trim(), RESULT_COUNT).await?;
    record_search(&app, provider.id, cost);
    Ok(results)
}

/// What the saved key's account has used. Asks the provider (its usage
/// endpoints cost nothing), except for Exa, whose usage API needs an admin
/// key: Better Search adds up the cost of the searches it made instead.
#[tauri::command]
pub async fn api_usage(app: AppHandle, provider: String) -> Result<Usage, String> {
    let provider = self::provider(&provider)?;
    let key = vault::read(provider.id).ok_or_else(|| format!("No {} key saved.", provider.name))?;
    let http = api_client();
    match provider.id {
        "exa" => Ok(Usage {
            used: Some(tally(&app, provider.id).usd),
            unit: "usd",
            period: "month",
            local: true,
            ..Default::default()
        }),
        "firecrawl" => {
            let request = http.get("https://api.firecrawl.dev/v2/team/credit-usage").bearer_auth(&key);
            let body = send(&provider, request, "report usage").await?;
            let left = body["data"]["remainingCredits"].as_f64();
            // The plan's credits, less what's left; coupons can leave more
            // than the plan, and then there's no telling.
            let used = match (body["data"]["planCredits"].as_f64(), left) {
                (Some(plan), Some(left)) if plan >= left => Some(plan - left),
                _ => None,
            };
            Ok(Usage { used, left, unit: "credits", period: "billing period", ..Default::default() })
        }
        "tinyfish" => {
            let since = this_month().1;
            let searches = http
                .get("https://api.search.tinyfish.ai/usage")
                .header("X-API-Key", &key)
                .query(&[("start_after", since.as_str()), ("limit", "1")]);
            let searches = send(&provider, searches, "report usage").await;
            let wallet = send(&provider, http.get("https://agent.tinyfish.ai/v1/wallet").header("X-API-Key", &key), "report usage").await;
            if let (Err(e), Err(_)) = (&searches, &wallet) {
                return Err(e.clone());
            }
            Ok(Usage {
                used: searches.ok().and_then(|b| b["total"].as_f64()),
                unit: "searches",
                period: "month",
                balance_usd: wallet.ok().and_then(|b| b["available_balance"].as_str()?.parse().ok()),
                ..Default::default()
            })
        }
        _ => {
            let request = http.get("https://api.context.dev/v1/org/usage").bearer_auth(&key);
            let body = send(&provider, request, "report usage (it needs the logs:read permission)").await?;
            Ok(Usage {
                used: body["period"]["credits_used"].as_f64(),
                left: body["credits_remaining"].as_f64(),
                unit: "credits",
                period: "month",
                ..Default::default()
            })
        }
    }
}

/// The keys in Credential Manager, as generic credentials named
/// "better-search/<provider>" (AI providers' as "better-search/ai/<provider>",
/// see ai.rs).
#[cfg(windows)]
pub(crate) mod vault {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    fn target(provider: &str) -> Vec<u16> {
        format!("better-search/{provider}").encode_utf16().chain(Some(0)).collect()
    }

    pub fn read(provider: &str) -> Option<String> {
        let target = target(provider);
        let mut cred: *mut CREDENTIALW = std::ptr::null_mut();
        unsafe { CredReadW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None, &mut cred) }.ok()?;
        let key = unsafe {
            let c = &*cred;
            String::from_utf8(std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize).to_vec()).ok()
        };
        unsafe { CredFree(cred as *const _) };
        key.filter(|k| !k.is_empty())
    }

    pub fn write(provider: &str, key: &str) -> Result<(), String> {
        let mut target = target(provider);
        let mut blob = key.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Type: CRED_TYPE_GENERIC,
            TargetName: PWSTR(target.as_mut_ptr()),
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            ..Default::default()
        };
        unsafe { CredWriteW(&cred, 0) }.map_err(|e| format!("Couldn't save the key: {}", e.message()))
    }

    pub fn delete(provider: &str) -> Result<(), String> {
        let target = target(provider);
        match unsafe { CredDeleteW(PCWSTR(target.as_ptr()), CRED_TYPE_GENERIC, None) } {
            // Already gone is fine.
            Err(e) if e.code() != windows::Win32::Foundation::ERROR_NOT_FOUND.to_hresult() => {
                Err(format!("Couldn't remove the key: {}", e.message()))
            }
            _ => Ok(()),
        }
    }
}

#[cfg(not(windows))]
pub(crate) mod vault {
    pub fn read(_provider: &str) -> Option<String> {
        None
    }

    pub fn write(_provider: &str, _key: &str) -> Result<(), String> {
        Err("Saving keys needs Windows.".into())
    }

    pub fn delete(_provider: &str) -> Result<(), String> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_icon_links() {
        let html = r#"<head><link rel="stylesheet" href="a.css"><LINK REL='shortcut icon' HREF='/fav.ico'>
            <link href="/icon.svg" rel="icon" type="image/svg+xml"></head>"#;
        assert_eq!(icon_link(html).as_deref(), Some("/icon.svg"));
        assert_eq!(icon_link(r#"<link rel=icon href=/x.ico>"#).as_deref(), Some("/x.ico"));
        assert_eq!(icon_link(r#"<link rel="stylesheet" href="a.css">"#), None);
    }

    #[test]
    fn local_addresses() {
        let local = |url: &str| is_local(&reqwest::Url::parse(url).unwrap());
        for url in [
            "http://localhost:8080/",
            "http://127.0.0.1/",
            "http://192.168.1.1/",
            "http://10.0.0.5/",
            "http://169.254.169.254/",
            "http://100.64.0.1/",
            "http://[::1]/",
            "http://[fd00::1]/",
            "http://[::ffff:192.168.0.1]/",
            "http://router/",
            "http://nas.local/",
        ] {
            assert!(local(url), "{url}");
        }
        for url in ["https://example.com/", "https://8.8.8.8/", "https://[2606:4700::1111]/"] {
            assert!(!local(url), "{url}");
        }
    }

    #[test]
    fn months() {
        assert_eq!(month_of(0), (1970, 1));
        assert_eq!(month_of(11_017), (2000, 3)); // 2000-03-01
        assert_eq!(month_of(19_782), (2024, 2)); // 2024-02-29
        assert_eq!(month_of(20_750), (2026, 10)); // 2026-10-24
    }

    #[test]
    fn sniffs_images() {
        assert_eq!(image_type(&[0, 0, 1, 0, 1]), Some("image/x-icon"));
        assert_eq!(image_type(b"\x89PNG\r\n"), Some("image/png"));
        assert_eq!(image_type(b"<?xml version=\"1.0\"?><svg>"), Some("image/svg+xml"));
        assert_eq!(image_type(b"<!doctype html><title>404</title>"), None);
    }
}
