import { useState } from "react";
import { useSkills } from "./useSkills.js";
import type { Skill } from "./useSkills.js";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

type Category = "skill";

export default function SettingsModal({ open, onClose }: SettingsModalProps) {
  const [category] = useState<Category>("skill");
  const { skills, loading, error, create, update, remove } = useSkills(open);

  if (!open) return null;

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title"><i className="ti ti-settings-filled" aria-hidden="true" /> 设置</span>
          <button className="settings-close" onClick={onClose} aria-label="关闭"><i className="ti ti-x" aria-hidden="true" /></button>
        </div>
        <div className="settings-body">
          <nav className="settings-nav">
            <button className={`settings-nav-item ${category === "skill" ? "active" : ""}`}>
              <i className="ti ti-book" aria-hidden="true" /> Skill
            </button>
          </nav>
          <div className="settings-content">
            {category === "skill" && (
              <SkillManager
                skills={skills}
                loading={loading}
                error={error}
                onCreate={create}
                onUpdate={update}
                onDelete={remove}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface SkillManagerProps {
  skills: Skill[];
  loading: boolean;
  error: string | null;
  onCreate: (name: string, content: string) => Promise<void>;
  onUpdate: (name: string, content: string, newName?: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
}

function SkillManager({ skills, loading, error, onCreate, onUpdate, onDelete }: SkillManagerProps) {
  const [creating, setCreating] = useState(false);

  return (
    <div className="skill-manager">
      <div className="skill-manager-bar">
        <span className="skill-manager-hint">每个 skill 是一段做事的方法论（markdown），会注入规划 agent 作参考。</span>
        <button className="skill-add-btn" onClick={() => setCreating(true)} disabled={creating}>
          <i className="ti ti-plus" aria-hidden="true" /> 新建 skill
        </button>
      </div>
      {error && <div className="skill-error">{error}</div>}
      {loading && skills.length === 0 ? (
        <div className="skill-empty">加载中…</div>
      ) : (
        <div className="skill-list">
          {creating && (
            <SkillEditor
              isNew
              initialName=""
              initialContent={"---\nname: \ndescription: \n---\n\n## 适用场景\n\n## 做法\n"}
              onSave={async (name, content) => { await onCreate(name, content); setCreating(false); }}
              onCancel={() => setCreating(false)}
              onDelete={undefined}
            />
          )}
          {skills.map((s) => (
            <SkillEditor
              key={s.name}
              isNew={false}
              initialName={s.name}
              initialContent={s.content}
              onSave={(name, content) => onUpdate(s.name, content, name)}
              onCancel={undefined}
              onDelete={() => onDelete(s.name)}
            />
          ))}
          {!creating && skills.length === 0 && <div className="skill-empty">还没有 skill，点"新建 skill"添加一个。</div>}
        </div>
      )}
    </div>
  );
}

interface SkillEditorProps {
  isNew: boolean;
  initialName: string;
  initialContent: string;
  onSave: (name: string, content: string) => Promise<void>;
  onCancel?: () => void;
  onDelete?: () => Promise<void>;
}

function SkillEditor({ isNew, initialName, initialContent, onSave, onCancel, onDelete }: SkillEditorProps) {
  const [name, setName] = useState(initialName);
  const [content, setContent] = useState(initialContent);
  const [busy, setBusy] = useState(false);
  const [localErr, setLocalErr] = useState<string | null>(null);

  const dirty = name !== initialName || content !== initialContent;

  const handleSave = async () => {
    setBusy(true);
    setLocalErr(null);
    try {
      await onSave(name.trim(), content);
    } catch (e) {
      setLocalErr(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm(`删除 skill「${initialName}」？此操作不可撤销。`)) return;
    setBusy(true);
    setLocalErr(null);
    try {
      await onDelete();
    } catch (e) {
      setLocalErr(String(e instanceof Error ? e.message : e));
      setBusy(false);
    }
  };

  return (
    <div className="skill-editor">
      <div className="skill-editor-head">
        <input
          className="skill-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="skill 名（小写字母/数字/连字符）"
        />
        <div className="skill-editor-actions">
          <button className="skill-save-btn" onClick={handleSave} disabled={busy || !name.trim() || (!isNew && !dirty)}>
            {busy ? "…" : isNew ? "创建" : "保存"}
          </button>
          {onCancel && <button className="skill-cancel-btn" onClick={onCancel} disabled={busy}>取消</button>}
          {onDelete && <button className="skill-delete-btn" onClick={handleDelete} disabled={busy} title="删除"><i className="ti ti-trash" aria-hidden="true" /></button>}
        </div>
      </div>
      <textarea
        className="skill-content-input"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        spellCheck={false}
        rows={Math.min(20, Math.max(6, content.split("\n").length + 1))}
      />
      {localErr && <div className="skill-error">{localErr}</div>}
    </div>
  );
}
