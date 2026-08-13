use aws_lambda_events::cognito::CognitoEventUserPoolsPreSignup;
use lambda_runtime::{run, service_fn, Error, LambdaEvent};

/// このPoCはメール確認(SESセットアップ)を要求しないセルフサインアップにするため、
/// `PreSignUp`トリガーで自動確認を返し、Cognitoの標準フローが要求する確認コード入力
/// ステップ自体を省略する(docs/adr/0016決定1)。イベントは発行しない——サインアップは
/// この時点ではまだ「本物」になっておらず(自動確認とはいえユーザーの確定はCognito側の
/// 処理完了後)、`PostConfirmation`トリガーが`auth.event.SignedUp`を発行する
/// (`post_confirmation.rs`)。
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt().with_max_level(tracing::Level::INFO).with_target(false).without_time().init();

    run(service_fn(handler)).await
}

async fn handler(
    event: LambdaEvent<CognitoEventUserPoolsPreSignup>,
) -> Result<CognitoEventUserPoolsPreSignup, Error> {
    let mut event = event.payload;
    event.response.auto_confirm_user = true;
    // auto_verify_emailは立てない: このUser Poolはユーザー名+パスワードのみ
    // (signInAliases: { username: true })で、サインアップ時にメールアドレス自体を
    // 収集していない。ここをtrueにすると「メールを自動確認済みにしろと言われたが
    // サインアップ時にメールが一つも渡されていない」とCognito自身が矛盾を検出し、
    // SignUp呼び出しそのものを`InvalidLambdaResponseException`で拒否する
    // (実デプロイでapi-e2eのsignUpAndSignInが全滅して発覚)。
    Ok(event)
}
