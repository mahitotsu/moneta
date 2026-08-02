import { useState } from "react";
import { CustomerFlow } from "./components/CustomerFlow";
import { ChannelEmulatorScreen } from "./components/ChannelEmulatorScreen";

type Mode = "customer" | "channel-emulator";

function App() {
  const [mode, setMode] = useState<Mode>("customer");

  return (
    // 顧客ログイン(青)/外部チャネル(オレンジ)でテーマ色を変え、今どちらを表示しているか
    // 一目で分かるようにする(index.cssの.theme-customer/.theme-channel)。
    <div className={mode === "customer" ? "theme-customer" : "theme-channel"}>
      <nav className="mode-switch">
        <button
          type="button"
          className={mode === "customer" ? "active" : "secondary"}
          onClick={() => setMode("customer")}
        >
          顧客ログイン
        </button>
        <button
          type="button"
          className={mode === "channel-emulator" ? "active" : "secondary"}
          onClick={() => setMode("channel-emulator")}
        >
          外部チャネル
        </button>
      </nav>

      {mode === "customer" ? <CustomerFlow /> : <ChannelEmulatorScreen />}
    </div>
  );
}

export default App;
