import { useEffect, useState } from "react";
import type { PrefillState } from "./recallTypes.js";

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit?: () => void;
  prefill: PrefillState;
  placeholder?: string;
}

export default function PrefilledInput({ value, onChange, onSubmit, prefill, placeholder }: Props) {
  // 仅在第一次出现 exact 模式时填入；之后由用户控制
  const [didPrefill, setDidPrefill] = useState(false);
  useEffect(() => {
    if (prefill.mode === "exact" && !didPrefill && value === "") {
      onChange(prefill.value);
      setDidPrefill(true);
    }
    // 状态 hint 不自动填值；状态 empty 什么也不做
  }, [prefill, didPrefill, value, onChange]);

  return (
    <div className="prefilled-input">
      <div className="prefill-row">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && onSubmit) onSubmit(); }}
          placeholder={placeholder ?? "输入你的回答…"}
        />
        {prefill.mode === "exact" && didPrefill && (
          <span className="prefill-tag" title={`来自 run #${prefill.sourceRunId.slice(0, 4)}`}>
            {prefill.sourceLabel}
          </span>
        )}
      </div>
      {prefill.mode === "hint" && (
        <div className="prefill-hint" title={`来自 run #${prefill.sourceRunId.slice(0, 4)}`}>
          💡 {prefill.hint}
        </div>
      )}
    </div>
  );
}
