//! Previews of Word documents (.docx) for when Windows has no thumbnail of
//! them, as without Office: the page picture Word saved in the file if there
//! is one, else the document's opening paragraphs, which the preview draws as
//! a page. A .docx is a zip; the text is in word/document.xml.

use std::io::Read;

use serde::Serialize;

/// Paragraphs worth reading: more than the preview's square can show.
const MAX_PARAGRAPHS: usize = 30;
const MAX_PARAGRAPH_CHARS: usize = 400;
/// Enough of document.xml for the opening pages; the rest is never read.
const MAX_XML_BYTES: u64 = 2 * 1024 * 1024;
const MAX_THUMBNAIL_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
pub struct Paragraph {
    text: String,
    /// A title or heading style.
    heading: bool,
}

/// Matches `Preview` in src/lib/preview.ts.
#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum DocxPreview {
    Image { url: String },
    Page { paragraphs: Vec<Paragraph> },
}

/// The picture of the first page Word saves in docProps when asked to
/// ("Save thumbnail"), as a data URL. JPEG or PNG only: some apps save a
/// metafile, which a webview can't draw.
fn saved_thumbnail(zip: &mut zip::ZipArchive<std::fs::File>) -> Option<String> {
    use base64::Engine;
    let name = zip
        .file_names()
        .filter_map(Result::ok)
        .find(|n| n.to_ascii_lowercase().starts_with("docprops/thumbnail."))?
        .to_string();
    let mut bytes = Vec::new();
    zip.by_name(&name).ok()?.take(MAX_THUMBNAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let kind = match bytes.as_slice() {
        [0xFF, 0xD8, ..] => "image/jpeg",
        [0x89, b'P', b'N', b'G', ..] => "image/png",
        _ => return None,
    };
    Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Text with XML's escapes undone.
fn unescape(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let Some(end) = rest.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..end];
        let ch = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix("#x")
                .map(|hex| u32::from_str_radix(hex, 16))
                .or_else(|| entity.strip_prefix('#').map(str::parse))
                .and_then(Result::ok)
                .and_then(char::from_u32),
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// The opening paragraphs of word/document.xml (or the part of it read).
/// Text is in <w:t> runs inside <w:p> paragraphs; deleted text (<w:delText>)
/// and field codes are other elements, so they're left out on their own.
fn paragraphs(xml: &str) -> Vec<Paragraph> {
    let mut out = Vec::new();
    let mut text = String::new();
    let mut heading = false;
    let mut in_text = false;
    // Text boxes come twice: as drawn and again as a fallback for old Word.
    let mut in_fallback = false;
    let mut rest = xml;
    while let Some(lt) = rest.find('<') {
        if in_text && !in_fallback {
            text.push_str(&unescape(&rest[..lt]));
        }
        let Some(gt) = rest[lt..].find('>') else { break };
        let tag = &rest[lt + 1..lt + gt];
        rest = &rest[lt + gt + 1..];
        let (closing, body) = match tag.strip_prefix('/') {
            Some(body) => (true, body),
            None => (false, tag),
        };
        let name = body.split(|c: char| c.is_whitespace() || c == '/').next().unwrap_or("");
        match (closing, name) {
            (false, "w:t") => in_text = !tag.ends_with('/'),
            (true, "w:t") => in_text = false,
            (false, "w:tab") if !in_fallback => text.push(' '),
            (false, "w:br" | "w:cr") if !in_fallback => text.push(' '),
            (false, "w:pStyle") => {
                let style = body.split("w:val=\"").nth(1).and_then(|v| v.split('"').next()).unwrap_or("");
                let style = style.to_ascii_lowercase();
                heading = style.starts_with("heading") || style.starts_with("title") || style.starts_with("subtitle");
            }
            (false, "mc:Fallback") => in_fallback = !tag.ends_with('/'),
            (true, "mc:Fallback") => in_fallback = false,
            (true, "w:p") if !in_fallback => {
                let words = text.split_whitespace().collect::<Vec<_>>().join(" ");
                if !words.is_empty() {
                    out.push(Paragraph { text: words.chars().take(MAX_PARAGRAPH_CHARS).collect(), heading });
                    if out.len() >= MAX_PARAGRAPHS {
                        break;
                    }
                }
                text.clear();
                heading = false;
            }
            _ => {}
        }
    }
    out
}

fn preview(path: &str) -> Option<DocxPreview> {
    if crate::is_cloud_only(path) {
        return None;
    }
    let mut zip = zip::ZipArchive::new(std::fs::File::open(path).ok()?).ok()?;
    if let Some(url) = saved_thumbnail(&mut zip) {
        return Some(DocxPreview::Image { url });
    }
    let mut xml = Vec::new();
    zip.by_name("word/document.xml").ok()?.take(MAX_XML_BYTES).read_to_end(&mut xml).ok()?;
    let paragraphs = paragraphs(&String::from_utf8_lossy(&xml));
    (!paragraphs.is_empty()).then_some(DocxPreview::Page { paragraphs })
}

/// None for files that aren't a readable .docx (an old .doc, a password-
/// protected one) or have no text.
#[tauri::command]
pub async fn docx_preview(path: String) -> Option<DocxPreview> {
    tauri::async_runtime::spawn_blocking(move || preview(&path)).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_paragraphs() {
        let xml = r#"<w:document><w:body>
            <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Quarterly</w:t></w:r><w:r><w:t xml:space="preserve"> report</w:t></w:r></w:p>
            <w:p><w:r><w:t>Tom &amp; Jerry&#8217;s</w:t><w:tab/><w:t>plan</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>
            <w:p></w:p>
            <w:p><w:r><mc:AlternateContent><mc:Choice><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></mc:Choice><mc:Fallback><w:txbxContent><w:p><w:r><w:t>Box</w:t></w:r></w:p></w:txbxContent></mc:Fallback></mc:AlternateContent></w:r></w:p>
        </w:body></w:document>"#;
        let found: Vec<(String, bool)> = paragraphs(xml).into_iter().map(|p| (p.text, p.heading)).collect();
        assert_eq!(
            found,
            vec![
                ("Quarterly report".to_string(), true),
                ("Tom & Jerry\u{2019}s plan".to_string(), false),
                ("Box".to_string(), false),
            ]
        );
    }

    #[test]
    fn unescapes() {
        assert_eq!(unescape("a &lt;b&gt; &#x41;&#66; & c"), "a <b> AB & c");
    }
}
