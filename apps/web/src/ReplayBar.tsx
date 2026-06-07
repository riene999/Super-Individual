import { useState } from "react";
import type { RunEvent } from "./types.js";

interface Props {
  events: RunEvent[];
  onReplay: (fromIndex: number, newText: string) => void;
}

export default function ReplayBar({ events, onReplay }: Props) {
  const [idx, setIdx] = useState(0);
  const [text, setText] = useState("");

  const replayableTypes = [
    "run.started", "clarify.done", "plan.done", "plan.generic", "locate.done", "code.done",
  ];
  const options = events
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => replayableTypes.includes(e.type));

  if (!options.length) return null;

  return (
    <div className="replay-bar">
      <i className="ti ti-rewind" aria-hidden="true" />
      <span className="label">重放自</span>
      <select value={idx} onChange={(e) => setIdx(Number(e.target.value))}>
        {options.map(({ e, i }) => (
          <option key={i} value={i}>#{i} {e.type}</option>
        ))}
      </select>
      <input
        placeholder="修改后的需求（留空则用原始需求）"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button onClick={() => onReplay(idx, text)}>重放</button>
    </div>
  );
}
