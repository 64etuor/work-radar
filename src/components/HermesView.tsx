import { useEffect } from "react";

import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import { useHermesAgent } from "./hermes/useHermesAgent";

export default function HermesView() {
  const agent = useHermesAgent();

  useEffect(() => {
    // Auto-start the ACP session on first mount.
    void agent.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <HermesPanel onRestart={agent.restart}>
      <div className="flex min-h-0 flex-1 flex-col">
        <HermesChatLog messages={agent.messages} />
        <HermesChatInput
          onSend={agent.send}
          onCancel={agent.cancel}
          disabled={agent.status === "starting"}
          isStreaming={agent.isStreaming}
          commandsList={agent.commandsList}
        />
      </div>
    </HermesPanel>
  );
}
