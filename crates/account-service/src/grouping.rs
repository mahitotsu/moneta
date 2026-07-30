use std::collections::HashMap;

use aws_lambda_events::sqs::SqsMessage;

/// SQS FIFOの1バッチには複数のMessageGroupIdのメッセージが混在し得るため、
/// Lambdaハンドラー内でMessageGroupIdごとにグルーピングし直す。
///
/// 各グループ内は`SequenceNumber`（128ビット、MessageGroupIdごとに単調増加すると
/// SQSのSendMessage APIリファレンスで保証されている）でソートし直す。
/// SQSの`ReceiveMessage`はMessageGroupIdごとに送信時刻順で返すとAPIリファレンスに
/// 明記されているが、それをLambdaのイベントソースマッピングがバッチ化する際に
/// 順序を保持するかは公式には明文化されていないため、順序をこちらの実装が持つ
/// 情報（SequenceNumber）だけで保証し、その未文書化の一段階に依存しないようにする。
pub fn group_by_message_group_id(records: Vec<SqsMessage>) -> Vec<(String, Vec<SqsMessage>)> {
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<SqsMessage>> = HashMap::new();

    for record in records {
        let group_id = record
            .attributes
            .get("MessageGroupId")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());

        if !groups.contains_key(&group_id) {
            order.push(group_id.clone());
        }
        groups.entry(group_id).or_default().push(record);
    }

    order
        .into_iter()
        .map(|group_id| {
            let mut messages = groups.remove(&group_id).expect("group was just inserted above");
            messages.sort_by_key(sequence_number);
            (group_id, messages)
        })
        .collect()
}

/// FIFOメッセージの`SequenceNumber`属性（128ビット、MessageGroupIdごとに単調増加）を
/// パースする。欠落・パース不能な場合は0として扱い、安定ソートにより元の相対順序を維持する。
fn sequence_number(message: &SqsMessage) -> u128 {
    message
        .attributes
        .get("SequenceNumber")
        .and_then(|value| value.parse::<u128>().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(message_id: &str, group_id: &str) -> SqsMessage {
        let mut message = SqsMessage::default();
        message.message_id = Some(message_id.to_string());
        message
            .attributes
            .insert("MessageGroupId".to_string(), group_id.to_string());
        message
    }

    fn message_with_sequence(message_id: &str, group_id: &str, sequence_number: u128) -> SqsMessage {
        let mut message = message(message_id, group_id);
        message
            .attributes
            .insert("SequenceNumber".to_string(), sequence_number.to_string());
        message
    }

    #[test]
    fn groups_are_kept_in_first_seen_order_and_preserve_message_order_within_group() {
        let records = vec![
            message("m1", "account-a"),
            message("m2", "account-b"),
            message("m3", "account-a"),
            message("m4", "account-a"),
            message("m5", "account-b"),
        ];

        let groups = group_by_message_group_id(records);

        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "account-a");
        assert_eq!(
            groups[0].1.iter().map(|m| m.message_id.clone().unwrap()).collect::<Vec<_>>(),
            vec!["m1", "m3", "m4"]
        );
        assert_eq!(groups[1].0, "account-b");
        assert_eq!(
            groups[1].1.iter().map(|m| m.message_id.clone().unwrap()).collect::<Vec<_>>(),
            vec!["m2", "m5"]
        );
    }

    #[test]
    fn messages_arriving_out_of_order_are_sorted_by_sequence_number_within_group() {
        // 128ビットのSequenceNumberはu64::MAXを超えうるため、u128でしか表現できない値で検証する。
        let records = vec![
            message_with_sequence("m3", "account-a", 18_849_496_460_467_696_130),
            message_with_sequence("m1", "account-a", 18_849_496_460_467_696_128),
            message_with_sequence("m2", "account-a", 18_849_496_460_467_696_129),
        ];

        let groups = group_by_message_group_id(records);

        assert_eq!(
            groups[0].1.iter().map(|m| m.message_id.clone().unwrap()).collect::<Vec<_>>(),
            vec!["m1", "m2", "m3"]
        );
    }

    #[test]
    fn message_without_group_id_falls_back_to_unknown_group() {
        let mut no_group = SqsMessage::default();
        no_group.message_id = Some("m1".to_string());

        let groups = group_by_message_group_id(vec![no_group]);

        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, "unknown");
    }
}
