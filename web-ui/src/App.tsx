import { useState } from "react";
import { CustomerFlow } from "./components/CustomerFlow";
import { ChannelEmulatorScreen } from "./components/ChannelEmulatorScreen";

type Mode = "customer" | "channel-emulator";

function App() {
  const [mode, setMode] = useState<Mode>("customer");

  return (
    <>
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
    </>
  );
}

export default App;
