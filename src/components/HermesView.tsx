import { HermesChatInput } from "./hermes/HermesChatInput";
import { HermesChatLog } from "./hermes/HermesChatLog";
import { HermesPanel } from "./hermes/HermesPanel";
import { useHermesAgent } from "./hermes/useHermesAgent";

export default function HermesView() {
  // Session auto-starts inside useHermesAgent once event listeners are wired,
  // so we don't kick off start() from here (avoids race-before-listeners).
  const agent = useHermesAgent();

  return (
    <HermesPanel onRestart={agent.restart} isStreaming={agent.isStreaming}>
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
