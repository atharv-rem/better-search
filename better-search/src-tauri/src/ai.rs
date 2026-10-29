//! Answers in the search window from an AI model, through the user's own API
//! key for a provider (bring your own key), or a model running on this machine
//! (Ollama, LM Studio). As with web search (web_search.rs), the keys live in
//! Windows Credential Manager and every request is made from here: the pages
//! only learn whether a key is saved, and get the answer as it streams in.

use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        OnceLock,
    },
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, State};

use crate::settings::{self, SettingsState};
use crate::web_search::vault;

#[derive(Clone, Copy, PartialEq)]
enum Api {
    /// OpenAI's chat completions, which every provider here but Anthropic
    /// speaks.
    OpenAi,
    Anthropic,
}

/// How saving a key checks it.
#[derive(Clone, Copy)]
enum Check {
    /// Lists the models: free, and turned down without a good key.
    Models,
    /// Asks for the key's own details (OpenRouter's model list is public).
    Url(&'static str),
    /// A one-word answer from the default model, where nothing free tells.
    Answer,
}

struct Provider {
    id: &'static str,
    name: &'static str,
    api: Api,
    /// Without the trailing slash; chat completions are at `{base}/chat/completions`.
    base: &'static str,
    /// Where its model list is, when not `{base}/models`; None: a fixed list.
    models_url: Option<&'static str>,
    /// Empty: the first model it lists (see `pick_default`).
    default_model: &'static str,
    /// Runs on this machine, without a key.
    local: bool,
    check: Check,
}

/// Keep in step with `AI_PROVIDERS` in src/lib/ai.ts.
pub const PROVIDERS: [&str; 10] =
    ["google", "groq", "openrouter", "github", "openai", "anthropic", "deepseek", "perplexity", "ollama", "lmstudio"];

fn provider(id: &str) -> Result<Provider, String> {
    let p = |id, name, base, default_model, check| Provider {
        id,
        name,
        api: Api::OpenAi,
        base,
        models_url: Some(""),
        default_model,
        local: false,
        check,
    };
    Ok(match id {
        "google" => p(
            "google",
            "Google AI Studio",
            "https://generativelanguage.googleapis.com/v1beta/openai",
            "gemini-flash-latest",
            Check::Models,
        ),
        "groq" => p("groq", "Groq", "https://api.groq.com/openai/v1", "llama-3.3-70b-versatile", Check::Models),
        // Its free models come and go: the first listed one is used.
        "openrouter" => p("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "", Check::Url("https://openrouter.ai/api/v1/key")),
        "github" => Provider {
            models_url: Some("https://models.github.ai/catalog/models"),
            ..p("github", "GitHub Models", "https://models.github.ai/inference", "openai/gpt-4.1-mini", Check::Answer)
        },
        "openai" => p("openai", "OpenAI", "https://api.openai.com/v1", "gpt-5-mini", Check::Models),
        "anthropic" => Provider {
            api: Api::Anthropic,
            ..p("anthropic", "Claude", "https://api.anthropic.com/v1", "claude-opus-5-5", Check::Models)
        },
        "deepseek" => p("deepseek", "DeepSeek", "https://api.deepseek.com/v1", "deepseek-chat", Check::Models),
        // No model list to ask for.
        "perplexity" => Provider { models_url: None, ..p("perplexity", "Perplexity", "https://api.perplexity.ai", "sonar", Check::Answer) },
        "ollama" => Provider { local: true, ..p("ollama", "Ollama", "http://localhost:11434/v1", "", Check::Models) },
        "lmstudio" => Provider { local: true, ..p("lmstudio", "LM Studio", "http://localhost:1234/v1", "", Check::Models) },
        _ => return Err(format!("unknown AI provider: {id}")),
    })
}

/// Perplexity's models, as it has no list to ask for.
const PERPLEXITY_MODELS: [&str; 4] = ["sonar", "sonar-pro", "sonar-reasoning", "sonar-reasoning-pro"];

/// Claude models that take `fallbacks: "default"`: a declined answer is
/// rerun on another model instead of coming back empty.
const CLAUDE_FALLBACK_MODELS: [&str; 4] = ["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5"];

fn vault_name(provider: &Provider) -> String {
    format!("ai/{}", provider.id)
}

/// Whether a provider has a key saved, for the settings page.
#[derive(Serialize)]
pub struct KeyStatus {
    provider: &'static str,
    /// The key's last four characters; None when there's no key.
    hint: Option<String>,
}

fn status(provider: &Provider) -> KeyStatus {
    let hint = vault::read(&vault_name(provider)).map(|key| key.chars().skip(key.chars().count().saturating_sub(4)).collect());
    KeyStatus { provider: provider.id, hint }
}

/// For the providers' APIs. Like web_search's `api_client`, it never follows
/// a redirect, which would take the key along. No overall timeout, as a long
/// answer takes a while: only a pause in it does.
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("HTTP client")
    })
}

/// A request to `url` with `key`, as the provider wants it sent.
fn request(provider: &Provider, method: reqwest::Method, url: &str, key: Option<&str>) -> reqwest::RequestBuilder {
    let request = client().request(method, url);
    match (provider.api, key) {
        (Api::Anthropic, Some(key)) => request.header("x-api-key", key).header("anthropic-version", "2026-10-21"),
        (Api::OpenAi, Some(key)) => request.bearer_auth(key),
        (_, None) => request,
    }
}

/// The saved key, or None for a local provider.
fn key_for(provider: &Provider) -> Result<Option<String>, String> {
    if provider.local {
        return Ok(None);
    }
    vault::read(&vault_name(provider))
        .map(Some)
        .ok_or_else(|| format!("Add your {} key in Settings → API keys.", provider.name))
}

/// The response, or a message to show: the provider's own reason when it
/// gives one. `doing` finishes "couldn't ...", like "answer".
async fn send(provider: &Provider, request: reqwest::RequestBuilder, doing: &str) -> Result<reqwest::Response, String> {
    let response = request.send().await.map_err(|e| {
        if provider.local && e.is_connect() {
            format!("Couldn't reach {}. Is it running?", provider.name)
        } else if e.is_timeout() {
            format!("{} took too long to answer.", provider.name)
        } else {
            format!("Couldn't reach {}. Check your internet connection.", provider.name)
        }
    })?;
    let status = response.status().as_u16();
    if status == 200 {
        return Ok(response);
    }
    let body: Value = response.json().await.unwrap_or_default();
    // { "error": { "message" } } for most; Google wraps it in a list.
    let reason = [&body["error"]["message"], &body[0]["error"]["message"], &body["error"], &body["message"]]
        .into_iter()
        .find_map(|v| v.as_str())
        .map(|m| m.chars().take(200).collect::<String>());
    Err(match (status, reason) {
        (401, _) => format!("{} didn't accept the API key.", provider.name),
        (402, _) => format!("Your {} account is out of credits.", provider.name),
        (429, _) => format!("Too many requests to {} right now, or the free limit is reached. Try again in a moment.", provider.name),
        (_, Some(reason)) => format!("{} couldn't {doing}: {reason}", provider.name),
        _ => format!("{} couldn't {doing} (error {status}).", provider.name),
    })
}

/// Not for chat: embeddings, speech, images.
fn is_chat_model(id: &str) -> bool {
    const NOT_CHAT: [&str; 16] = [
        "embed", "whisper", "tts", "dall-e", "moderation", "audio", "realtime", "transcribe", "image", "imagen", "veo",
        "aqa", "davinci", "babbage", "sora", "guard",
    ];
    let id = id.to_ascii_lowercase();
    !NOT_CHAT.iter().any(|word| id.contains(word))
}

/// The chat models `key` can use, in the provider's order.
async fn list_models(provider: &Provider, key: Option<&str>) -> Result<Vec<String>, String> {
    let url = match provider.models_url {
        None => return Ok(PERPLEXITY_MODELS.map(String::from).to_vec()),
        Some("") => format!("{}/models", provider.base),
        Some(url) => url.to_string(),
    };
    let mut get = request(provider, reqwest::Method::GET, &url, key);
    if provider.api == Api::Anthropic {
        get = get.query(&[("limit", "100")]);
    }
    let body: Value = send(provider, get, "list its models")
        .await?
        .json()
        .await
        .map_err(|_| format!("{} sent a model list Better Search couldn't read.", provider.name))?;
    // { "data": [{ "id" }] }, or GitHub's bare list.
    let items = body["data"].as_array().or(body.as_array()).map(Vec::as_slice).unwrap_or_default();
    Ok(items
        .iter()
        .filter_map(|m| m["id"].as_str())
        // Google's are "models/gemini-…"; its chat completions take them without.
        .map(|id| id.trim_start_matches("models/").to_string())
        .filter(|id| is_chat_model(id))
        .collect())
}

/// The model to use when the user hasn't picked one: the provider's default,
/// else the first listed (for OpenRouter, the first free one).
fn pick_default(provider: &Provider, models: &[String]) -> Option<String> {
    if !provider.default_model.is_empty() {
        return Some(provider.default_model.to_string());
    }
    let free = |m: &&String| provider.id != "openrouter" || m.ends_with(":free");
    models.iter().find(free).cloned()
}

#[tauri::command]
pub fn ai_keys() -> Vec<KeyStatus> {
    PROVIDERS.iter().filter_map(|id| provider(id).ok()).filter(|p| !p.local).map(|p| status(&p)).collect()
}

/// Checks `key` with the provider (see `Check`), then saves it. Nothing is
/// saved when the provider turns it down.
#[tauri::command]
pub async fn save_ai_key(provider: String, key: String) -> Result<KeyStatus, String> {
    let provider = self::provider(&provider)?;
    if provider.local {
        return Err(format!("{} runs on this computer and needs no key.", provider.name));
    }
    let key = key.trim();
    if key.is_empty() {
        return Err("Paste a key first.".into());
    }
    match provider.check {
        Check::Models => {
            list_models(&provider, Some(key)).await?;
        }
        Check::Url(url) => {
            send(&provider, request(&provider, reqwest::Method::GET, url, Some(key)), "check the key").await?;
        }
        Check::Answer => {
            let body = json!({
                "model": provider.default_model,
                "max_tokens": 1,
                "messages": [{ "role": "user", "content": "Say OK." }],
            });
            let post = request(&provider, reqwest::Method::POST, &format!("{}/chat/completions", provider.base), Some(key));
            send(&provider, post.json(&body), "check the key").await?;
        }
    }
    vault::write(&vault_name(&provider), key)?;
    Ok(status(&provider))
}

/// Forgets the key. Questions that went to this provider are off again.
#[tauri::command]
pub fn remove_ai_key(app: AppHandle, state: State<'_, SettingsState>, provider: String) -> Result<KeyStatus, String> {
    let provider = self::provider(&provider)?;
    vault::delete(&vault_name(&provider))?;
    let current = state.0.lock().unwrap().clone();
    if current.ai.provider == provider.id {
        let mut changed = current;
        changed.ai.provider = "off".into();
        settings::update_settings(app, state, changed)?;
    }
    Ok(status(&provider))
}

/// The models to suggest in the settings page.
#[tauri::command]
pub async fn ai_models(provider: String) -> Result<Vec<String>, String> {
    let provider = self::provider(&provider)?;
    let key = key_for(&provider)?;
    list_models(&provider, key.as_deref()).await
}

/// A web result the answer can cite, by its place in the list (1-based).
#[derive(Clone, Serialize, Deserialize)]
pub struct Source {
    title: String,
    url: String,
    #[serde(default)]
    snippet: String,
}

/// What the page is sent while an answer streams in.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AiEvent {
    /// The next piece of the answer.
    Text { text: String },
    /// The pages the provider searched itself (Perplexity), when the page
    /// gave none.
    Sources { sources: Vec<Source> },
}

/// Bumped by every new question and by `stop_ai`: an answer streaming for an
/// older one stops.
static ASKING: AtomicU64 = AtomicU64::new(0);

const INSTRUCTIONS: &str = "You answer questions typed into Better Search, a search bar on a Windows PC. \
Latency-sensitive; begin your visible answer immediately. Be brief: one to three short paragraphs. \
Write plain text without Markdown: no headings, lists, bold, tables or code blocks. Separate paragraphs with a blank line.";

const CITING: &str = " Web search results come with the question, numbered. Base the answer on them and cite each claim \
right after it as [n], with the result's number; don't list the sources at the end. If they don't answer the question, \
say so briefly and answer from what you know.";

/// The question, after the web results it should draw on.
fn prompt(question: &str, sources: &[Source]) -> String {
    if sources.is_empty() {
        return question.to_string();
    }
    let mut text = String::from("Web search results:\n\n");
    for (i, s) in sources.iter().enumerate() {
        text += &format!("[{}] {}\n{}\n{}\n\n", i + 1, s.title, s.url, s.snippet);
    }
    text + "Question: " + question
}

/// Streams `provider`'s answer to `question` through `on_event`, as text
/// arrives. Resolves when it's complete, or when a newer question (or
/// `stop_ai`) stops it; rejects with a message to show.
#[tauri::command]
pub async fn ask_ai(
    provider: String,
    model: String,
    question: String,
    sources: Vec<Source>,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let asking = ASKING.fetch_add(1, Ordering::SeqCst) + 1;
    let provider = self::provider(&provider)?;
    let key = key_for(&provider)?;
    let model = match model.trim() {
        "" => {
            let listed = if provider.default_model.is_empty() { list_models(&provider, key.as_deref()).await? } else { Vec::new() };
            pick_default(&provider, &listed).ok_or_else(|| format!("{} has no models to answer with yet.", provider.name))?
        }
        model => model.to_string(),
    };
    let system = if sources.is_empty() || provider.id == "perplexity" {
        INSTRUCTIONS.to_string()
    } else {
        INSTRUCTIONS.to_string() + CITING
    };
    let user = prompt(question.trim(), &sources);

    let post = match provider.api {
        Api::Anthropic => {
            let mut body = json!({
                "model": model,
                "max_tokens": 16000,
                "stream": true,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            });
            let mut post = request(&provider, reqwest::Method::POST, &format!("{}/messages", provider.base), key.as_deref());
            if CLAUDE_FALLBACK_MODELS.contains(&model.as_str()) {
                body["fallbacks"] = json!("default");
                post = post.header("anthropic-beta", "server-side-fallback-2026-07-01");
            }
            post.json(&body)
        }
        Api::OpenAi => request(&provider, reqwest::Method::POST, &format!("{}/chat/completions", provider.base), key.as_deref())
            .json(&json!({
                "model": model,
                "stream": true,
                "messages": [{ "role": "system", "content": system }, { "role": "user", "content": user }],
            })),
    };
    let mut response = send(&provider, post, "answer").await?;

    // Server-sent events: "data: {...}" lines, split across chunks anywhere.
    let mut pending: Vec<u8> = Vec::new();
    let mut wrote = false;
    let mut sent_sources = !sources.is_empty();
    let mut refused = false;
    loop {
        if ASKING.load(Ordering::SeqCst) != asking {
            return Ok(());
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(e) if e.is_timeout() => return Err(format!("{} stopped answering.", provider.name)),
            Err(_) => return Err(format!("Lost the connection to {}.", provider.name)),
        };
        pending.extend_from_slice(&chunk);
        while let Some(end) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let Some(data) = line.trim().strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" {
                continue;
            }
            let Ok(event) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(message) = event["error"]["message"].as_str() {
                return Err(format!("{} couldn't answer: {message}", provider.name));
            }
            let text = match provider.api {
                Api::Anthropic => {
                    if event["delta"]["stop_reason"] == "refusal" {
                        refused = true;
                    }
                    (event["type"] == "content_block_delta" && event["delta"]["type"] == "text_delta")
                        .then(|| event["delta"]["text"].as_str())
                        .flatten()
                }
                // Reasoning ("reasoning_content") isn't shown.
                Api::OpenAi => event["choices"][0]["delta"]["content"].as_str(),
            };
            if !sent_sources {
                if let Some(found) = event["search_results"].as_array().filter(|r| !r.is_empty()) {
                    sent_sources = true;
                    let sources = found
                        .iter()
                        .filter_map(|r| {
                            let url = r["url"].as_str().filter(|u| u.starts_with("https://") || u.starts_with("http://"))?;
                            Some(Source {
                                title: r["title"].as_str().unwrap_or(url).to_string(),
                                url: url.to_string(),
                                snippet: r["snippet"].as_str().unwrap_or("").to_string(),
                            })
                        })
                        .collect();
                    let _ = on_event.send(AiEvent::Sources { sources });
                }
            }
            if let Some(text) = text.filter(|t| !t.is_empty()) {
                wrote = true;
                if on_event.send(AiEvent::Text { text: text.to_string() }).is_err() {
                    // The page is gone.
                    return Ok(());
                }
            }
        }
    }
    if refused && !wrote {
        return Err(format!("{} declined to answer that.", provider.name));
    }
    if !wrote {
        return Err(format!("{} sent an empty answer.", provider.name));
    }
    Ok(())
}

/// Stops the answer that's streaming, if any.
#[tauri::command]
pub fn stop_ai() {
    ASKING.fetch_add(1, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_provider_is_known() {
        for id in PROVIDERS {
            assert!(provider(id).is_ok(), "{id}");
        }
        assert!(provider("mistral").is_err());
    }

    #[test]
    fn skips_models_that_dont_chat() {
        assert!(is_chat_model("gpt-5-mini"));
        assert!(is_chat_model("gemini-flash-latest"));
        assert!(!is_chat_model("text-embedding-3-small"));
        assert!(!is_chat_model("whisper-1"));
        assert!(!is_chat_model("gpt-image-1"));
    }

    #[test]
    fn openrouter_defaults_to_a_free_model() {
        let p = provider("openrouter").unwrap();
        let listed = ["openai/gpt-5".to_string(), "meta-llama/llama-3.3-70b-instruct:free".to_string()];
        assert_eq!(pick_default(&p, &listed).as_deref(), Some("meta-llama/llama-3.3-70b-instruct:free"));
        assert_eq!(pick_default(&provider("ollama").unwrap(), &["llama3.2".into()]).as_deref(), Some("llama3.2"));
        assert_eq!(pick_default(&provider("ollama").unwrap(), &[]), None);
    }

    #[test]
    fn numbers_the_sources() {
        let s = Source { title: "T".into(), url: "https://a.com".into(), snippet: "S".into() };
        assert_eq!(prompt("q", &[]), "q");
        assert_eq!(prompt("q", &[s]), "Web search results:\n\n[1] T\nhttps://a.com\nS\n\nQuestion: q");
    }
}
