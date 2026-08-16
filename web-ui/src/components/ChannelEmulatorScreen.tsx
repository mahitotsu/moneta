import { ChannelOperationForm } from "./ChannelOperationForm";
import { deposit, withdraw } from "../api/client";

/**
 * 「外の世界」(ATM網・銀行間送金網・収納機関)を模擬する画面。サインイン不要——顧客自身の
 * セッションとは独立した、外部アクターからの操作を表す(docs/adr/0009)。振替(自分の口座間の
 * 資金移動)はここに含めない——それは顧客自身が行う操作であり、将来Transfer serviceを
 * 実装する際は顧客向け画面(セルフサービス)に置くべきものとして区別する。
 */
export function ChannelEmulatorScreen() {
  return (
    <>
      <h1>外部チャネル・エミュレータ</h1>
      <p className="subtitle">
        ネットバンキングの顧客は自分のWeb UIから直接入出金しません。入出金はATM・他行からの
        振込・収納機関への支払いなど、外部のチャネルを経由して発生します。この画面はそれらを
        模擬し、既存のDeposit/Withdrawコマンドをそのまま呼び出します(バックエンド無改修)。
      </p>

      <div className="operations-grid">
        <ChannelOperationForm
          title="ATM入金"
          description="顧客が自分でATMから現金を入金する操作を模擬します。"
          submitLabel="入金する"
          channel="Atm"
          action={deposit}
        />
        <ChannelOperationForm
          title="ATM出金"
          description="顧客が自分でATMから現金を引き出す操作を模擬します。"
          submitLabel="出金する"
          channel="Atm"
          action={withdraw}
        />
      </div>

      <ChannelOperationForm
        title="他行からの振込"
        description="別の金融機関から、この口座宛に振込があった状況を模擬します。"
        submitLabel="振込を反映する"
        counterpartyLabel="送金元銀行名(表示用、任意)"
        channel="IncomingTransfer"
        action={deposit}
      />

      <ChannelOperationForm
        title="収納機関への支払い"
        description="電気・水道等の収納機関が、この口座から自動引き落としを行った状況を模擬します。"
        submitLabel="引き落とす"
        counterpartyLabel="支払先名(表示用、任意)"
        channel="BillPayment"
        action={withdraw}
      />
    </>
  );
}
