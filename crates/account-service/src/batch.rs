use aws_lambda_events::sqs::SqsMessage;

/// FIFOキューでは順序を飛ばして再試行できないため、グループ内で`failed_from`番目の
/// メッセージが失敗したら、それ以降の全メッセージを失敗として報告し、まとめて再試行対象にする。
pub fn failed_message_ids_from(messages: &[SqsMessage], failed_from: usize) -> Vec<String> {
    messages[failed_from..]
        .iter()
        .filter_map(|message| message.message_id.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(message_id: &str) -> SqsMessage {
        let mut message = SqsMessage::default();
        message.message_id = Some(message_id.to_string());
        message
    }

    #[test]
    fn reports_failed_message_and_all_subsequent_ones() {
        let messages = vec![message("m1"), message("m2"), message("m3")];

        let failures = failed_message_ids_from(&messages, 1);

        assert_eq!(failures, vec!["m2", "m3"]);
    }

    #[test]
    fn no_failures_reported_when_failed_from_is_past_the_end() {
        let messages = vec![message("m1"), message("m2")];

        let failures = failed_message_ids_from(&messages, messages.len());

        assert!(failures.is_empty());
    }
}
