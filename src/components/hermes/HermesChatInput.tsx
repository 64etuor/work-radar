import { Send } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  onSend: (text: string, images: string[]) => void;
  disabled?: boolean;
}

export function HermesChatInput({ onSend, disabled }: Props) {
  const [text, setText] = useState("");

  const submit = useCallback(() => {
    if (!text.trim()) return;
    onSend(text, []);
    setText("");
  }, [text, onSend]);

  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Textarea
        className="max-h-[200px] min-h-[40px] flex-1 resize-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="메시지… (Shift+Enter 줄바꿈)"
        disabled={disabled}
      />
      <Button
        size="sm"
        className="h-9 w-9 shrink-0 p-0"
        onClick={submit}
        disabled={disabled || !text.trim()}
      >
        <Send className="h-4 w-4" />
      </Button>
    </div>
  );
}
