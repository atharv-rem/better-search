//! The calculator: "=3*2+4" in the search box shows "10" after the text.
//! fend does the math (exact decimals, units, percentages), offline: no
//! exchange-rate handler, so currencies don't convert.

use std::time::{Duration, Instant};

/// Longer than this and the answer isn't worth waiting for ("=100000!").
const TIME_LIMIT: Duration = Duration::from_millis(100);

struct Deadline(Instant);

impl fend_core::Interrupt for Deadline {
    fn should_interrupt(&self) -> bool {
        Instant::now() >= self.0
    }
}

/// The answer to `expr`, or None when it isn't one fend can work out in time.
pub fn evaluate(expr: &str) -> Option<String> {
    if expr.trim().is_empty() {
        return None;
    }
    let mut context = fend_core::Context::new();
    let deadline = Deadline(Instant::now() + TIME_LIMIT);
    let result = fend_core::evaluate_with_interrupt(expr, &mut context, &deadline).ok()?;
    let answer = result.get_main_result();
    (!result.output_is_empty() && !answer.is_empty()).then(|| answer.to_string())
}

/// Off the main thread, so a slow expression never holds up the window.
#[tauri::command]
pub async fn calculate(expr: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || evaluate(&expr)).await.ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic() {
        assert_eq!(evaluate("(3*2)+4").as_deref(), Some("10"));
        assert_eq!(evaluate("0.1+0.2").as_deref(), Some("0.3"));
    }

    #[test]
    fn nothing_for_empty_or_invalid() {
        assert_eq!(evaluate(""), None);
        assert_eq!(evaluate("   "), None);
        assert_eq!(evaluate("3 +* )"), None);
    }

    #[test]
    fn slow_expressions_give_up() {
        let started = Instant::now();
        assert_eq!(evaluate("100000000!"), None);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
