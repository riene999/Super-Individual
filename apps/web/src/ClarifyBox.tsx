import { useState } from "react";
import type { ClarifyingQ, PrefillState } from "./recallTypes.js";
import PrefilledInput from "./PrefilledInput.js";

interface Props {
  questions: ClarifyingQ[];
  prefills: Record<string, PrefillState>;
  onSubmit: (answers: Record<string, string>) => void;
}

export default function ClarifyBox({ questions, prefills, onSubmit }: Props) {
  const [answers, setAnswers] = useState<Record<string, string>>({});

  const handleSubmit = () => {
    const filled: Record<string, string> = {};
    for (const { q } of questions) filled[q] = answers[q] ?? "";
    onSubmit(filled);
  };

  return (
    <div className="clarify-box">
      <h3><i className="ti ti-help" aria-hidden="true" />需要澄清几个问题</h3>
      {questions.map(({ q, aspect }) => {
        const prefill = prefills[q] ?? { mode: "empty" as const };
        return (
          <div className="clarify-q" key={q}>
            <label>
              {q} <span className="aspect-chip subtle">{aspect}</span>
            </label>
            <PrefilledInput
              value={answers[q] ?? ""}
              onChange={(v) => setAnswers((prev) => ({ ...prev, [q]: v }))}
              onSubmit={handleSubmit}
              prefill={prefill}
            />
          </div>
        );
      })}
      <button onClick={handleSubmit}>提交答案 <i className="ti ti-arrow-right" aria-hidden="true" /></button>
    </div>
  );
}
