"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/cn";
import { OPERATORS, defaultOperator, defaultValue, operatorsForType } from "./operators";
import type {
  Combinator, EnumOption, FilterField, FilterRule, FilterState, OperatorKey,
} from "./types";

// Lightweight uid generator. We only need uniqueness within a render session,
// not cross-restart, so a counter is fine.
let uidCounter = 0;
const uid = () => `r${++uidCounter}`;

// ─── Public component ─────────────────────────────────────────────────────

export function FilterBar({
  fields, state, onChange, placeholder, totalRows, filteredRows,
}: {
  fields: FilterField[];
  state: FilterState;
  onChange: (s: FilterState) => void;
  placeholder?: string;
  totalRows?: number;
  filteredRows?: number;
}) {
  function addRule() {
    const f = fields[0];
    if (!f) return;
    const op = defaultOperator(f.type);
    const rule: FilterRule = { id: uid(), fieldKey: f.key, operator: op, value: defaultValue(op, f.type) };
    onChange({ ...state, rules: [...state.rules, rule] });
  }

  function removeRule(id: string) {
    onChange({ ...state, rules: state.rules.filter((r) => r.id !== id) });
  }

  function patchRule(id: string, patch: Partial<FilterRule>) {
    onChange({
      ...state,
      rules: state.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }

  function setCombinator(c: Combinator) {
    onChange({ ...state, combinator: c });
  }

  function clearAll() {
    onChange({ combinator: "and", rules: [] });
  }

  const empty = state.rules.length === 0;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Existing rules render as chips */}
      {state.rules.map((rule, i) => (
        <RuleChip
          key={rule.id}
          rule={rule}
          fields={fields}
          showCombinator={i > 0}
          combinator={state.combinator}
          onCombinatorChange={setCombinator}
          onChange={(patch) => patchRule(rule.id, patch)}
          onRemove={() => removeRule(rule.id)}
        />
      ))}

      {/* Add filter button */}
      <button
        onClick={addRule}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-[7px] text-[12.5px] font-medium transition",
          empty
            ? "border-rule2 bg-paper text-mute hover:border-brand-violet hover:text-brand-violet"
            : "border-rule bg-paper text-ink2 hover:border-brand-violet hover:text-brand-violet",
        )}
      >
        <Icon name="plus" size={12} strokeWidth={2.4} />
        {empty ? (placeholder ?? "Add filter") : "Add filter"}
      </button>

      {!empty && (
        <button
          onClick={clearAll}
          className="rounded-full px-2.5 py-[5px] text-[11.5px] font-semibold text-mute hover:text-state-warn"
        >
          Clear all
        </button>
      )}

      {totalRows != null && filteredRows != null && (
        <div className="ml-auto font-mono text-[11px] text-mute">
          {filteredRows === totalRows
            ? `${totalRows} total`
            : `${filteredRows} of ${totalRows}`}
        </div>
      )}
    </div>
  );
}

// ─── Single rule chip ─────────────────────────────────────────────────────

function RuleChip({
  rule, fields, onChange, onRemove,
  showCombinator, combinator, onCombinatorChange,
}: {
  rule: FilterRule;
  fields: FilterField[];
  onChange: (patch: Partial<FilterRule>) => void;
  onRemove: () => void;
  showCombinator: boolean;
  combinator: Combinator;
  onCombinatorChange: (c: Combinator) => void;
}) {
  const field = fields.find((f) => f.key === rule.fieldKey) ?? fields[0]!;
  const operator = OPERATORS[rule.operator];

  return (
    <div className="inline-flex items-stretch rounded-full border border-rule bg-paper text-[12.5px] [&>*:first-child]:rounded-l-full [&>*:last-child]:rounded-r-full">
      {showCombinator && (
        <CombinatorPicker value={combinator} onChange={onCombinatorChange} />
      )}

      <FieldPicker
        fields={fields}
        value={field.key}
        onChange={(newKey) => {
          const newField = fields.find((f) => f.key === newKey);
          if (!newField) return;
          // Keep operator if applicable to the new type, otherwise reset.
          const opStillFits = operator.appliesTo.includes(newField.type);
          const newOp = opStillFits ? rule.operator : defaultOperator(newField.type);
          onChange({
            fieldKey: newField.key,
            operator: newOp,
            value: defaultValue(newOp, newField.type),
          });
        }}
      />

      <OperatorPicker
        type={field.type}
        value={rule.operator}
        onChange={(newOp) => {
          onChange({
            operator: newOp,
            value: defaultValue(newOp, field.type),
          });
        }}
      />

      {operator.valueArity !== 0 && (
        <ValueEditor
          field={field}
          operator={rule.operator}
          value={rule.value}
          onChange={(v) => onChange({ value: v })}
        />
      )}

      <button
        onClick={onRemove}
        className="flex items-center justify-center px-2 text-mute transition hover:bg-warm hover:text-state-warn"
        aria-label="Remove filter"
      >
        <Icon name="plus" size={12} strokeWidth={2.4} className="rotate-45" />
      </button>
    </div>
  );
}

// ─── Combinator (and/or) ──────────────────────────────────────────────────

function CombinatorPicker({ value, onChange }: { value: Combinator; onChange: (c: Combinator) => void }) {
  return (
    <div className="flex items-center border-r border-rule bg-warm px-2 font-mono text-[10px] uppercase tracking-wider text-mute">
      <button onClick={() => onChange(value === "and" ? "or" : "and")} className="font-semibold">
        {value}
      </button>
    </div>
  );
}

// ─── Field picker (popover with full field list) ──────────────────────────

function FieldPicker({
  fields, value, onChange,
}: { fields: FilterField[]; value: string; onChange: (key: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  const current = fields.find((f) => f.key === value) ?? fields[0]!;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2.5 py-[6px] font-semibold text-ink hover:bg-warm"
      >
        <span>{current.label}</span>
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <Popover>
          {fields.map((f) => (
            <button
              key={f.key}
              onClick={() => { onChange(f.key); setOpen(false); }}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                f.key === value && "bg-warm font-semibold",
              )}
            >
              {f.label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

// ─── Operator picker ──────────────────────────────────────────────────────

function OperatorPicker({
  type, value, onChange,
}: { type: FilterField["type"]; value: OperatorKey; onChange: (op: OperatorKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  const ops = operatorsForType(type);
  const current = OPERATORS[value];

  return (
    <div ref={ref} className="relative border-l border-rule">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2.5 py-[6px] text-mute hover:bg-warm"
      >
        <span>{current.label}</span>
        <span className="text-[9px]">▾</span>
      </button>
      {open && (
        <Popover>
          {ops.map((op) => (
            <button
              key={op.key}
              onClick={() => { onChange(op.key); setOpen(false); }}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                op.key === value && "bg-warm font-semibold",
              )}
            >
              {op.label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

// ─── Value editor — switches by op + type ─────────────────────────────────

function ValueEditor({
  field, operator, value, onChange,
}: {
  field: FilterField;
  operator: OperatorKey;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const op = OPERATORS[operator];

  if (op.valueArity === "many" && field.type === "enum") {
    return <EnumMultiPicker options={field.options ?? []} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />;
  }
  if (op.valueArity === "many") {
    // For text "is_any_of" — comma-separated input
    return <TextInput
      placeholder="Comma-separated"
      value={Array.isArray(value) ? (value as string[]).join(", ") : ""}
      onChange={(s) => onChange(s.split(",").map((x) => x.trim()).filter(Boolean))}
    />;
  }
  if (op.valueArity === 2) {
    const arr = Array.isArray(value) ? (value as [unknown, unknown]) : [null, null];
    return (
      <div className="flex items-center gap-1 border-l border-rule px-2 py-[3px]">
        <input
          type={field.type === "number" ? "number" : "text"}
          value={(arr[0] ?? "") as string | number}
          onChange={(e) => onChange([field.type === "number" ? toNum(e.target.value) : e.target.value, arr[1]])}
          className="w-[60px] bg-transparent text-[12.5px] text-ink outline-none placeholder:text-hint"
          placeholder="min"
        />
        <span className="text-mute">–</span>
        <input
          type={field.type === "number" ? "number" : "text"}
          value={(arr[1] ?? "") as string | number}
          onChange={(e) => onChange([arr[0], field.type === "number" ? toNum(e.target.value) : e.target.value])}
          className="w-[60px] bg-transparent text-[12.5px] text-ink outline-none placeholder:text-hint"
          placeholder="max"
        />
      </div>
    );
  }
  // Single-value
  if (field.type === "enum") {
    return <EnumSinglePicker options={field.options ?? []} value={String(value ?? "")} onChange={onChange} />;
  }
  if (field.type === "boolean") {
    return <BooleanPicker value={Boolean(value)} onChange={onChange} />;
  }
  if (field.type === "number") {
    return <TextInput
      type="number"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(s) => onChange(toNum(s))}
      placeholder="Value"
    />;
  }
  if (field.type === "date") {
    return <TextInput
      type="date"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={onChange}
      placeholder="Date"
    />;
  }
  return <TextInput
    value={value === null || value === undefined ? "" : String(value)}
    onChange={onChange}
    placeholder="Value"
  />;
}

function toNum(s: string): number | null {
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// ─── Sub-editors ──────────────────────────────────────────────────────────

function TextInput({
  value, onChange, placeholder, type = "text",
}: {
  value: string; onChange: (s: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div className="flex border-l border-rule">
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-[140px] bg-transparent px-2.5 py-[6px] text-[12.5px] text-ink outline-none placeholder:text-hint"
      />
    </div>
  );
}

function BooleanPicker({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex border-l border-rule">
      <button
        onClick={() => onChange(!value)}
        className="px-2.5 py-[6px] font-semibold text-ink hover:bg-warm"
      >
        {value ? "true" : "false"}
      </button>
    </div>
  );
}

function EnumSinglePicker({
  options, value, onChange,
}: { options: EnumOption[]; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div ref={ref} className="relative border-l border-rule">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 px-2.5 py-[6px] hover:bg-warm"
      >
        {current ? (
          <span className={cn("inline-flex items-center rounded-full px-1.5 text-[11px] font-semibold", current.cls)}>
            {current.label}
          </span>
        ) : (
          <span className="text-mute">Choose…</span>
        )}
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <Popover>
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => { onChange(o.value); setOpen(false); }}
              className={cn(
                "block w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-warm",
                o.value === value && "bg-warm font-semibold",
              )}
            >
              {o.label}
            </button>
          ))}
        </Popover>
      )}
    </div>
  );
}

function EnumMultiPicker({
  options, value, onChange,
}: { options: EnumOption[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(() => setOpen(false));
  const set = new Set(value);
  function toggle(v: string) {
    const next = new Set(set);
    if (next.has(v)) next.delete(v); else next.add(v);
    onChange([...next]);
  }
  return (
    <div ref={ref} className="relative border-l border-rule">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex max-w-[260px] items-center gap-1 px-2.5 py-[6px] hover:bg-warm"
      >
        {value.length === 0 ? (
          <span className="text-mute">Choose…</span>
        ) : (
          <span className="flex flex-wrap items-center gap-1">
            {value.slice(0, 3).map((v) => {
              const o = options.find((o) => o.value === v);
              if (!o) return null;
              return (
                <span key={v} className={cn("rounded-full px-1.5 py-px text-[10.5px] font-semibold", o.cls ?? "bg-warm2 text-ink2")}>
                  {o.label}
                </span>
              );
            })}
            {value.length > 3 && <span className="text-[10.5px] text-mute">+{value.length - 3}</span>}
          </span>
        )}
        <span className="text-[9px] text-mute">▾</span>
      </button>
      {open && (
        <Popover>
          {options.map((o) => {
            const checked = set.has(o.value);
            return (
              <button
                key={o.value}
                onClick={() => toggle(o.value)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-warm"
              >
                <span
                  className={cn(
                    "flex h-3.5 w-3.5 items-center justify-center rounded border",
                    checked ? "border-brand-violet bg-brand-violet text-white" : "border-rule2",
                  )}
                >
                  {checked && <Icon name="check" size={10} strokeWidth={3} />}
                </span>
                <span>{o.label}</span>
              </button>
            );
          })}
        </Popover>
      )}
    </div>
  );
}

function Popover({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute left-0 top-full z-30 mt-1 min-w-[200px] max-h-[300px] overflow-y-auto rounded-lg border border-rule bg-paper py-1 shadow-card">
      {children}
    </div>
  );
}

// Small hook: close popover on outside click + escape
function useOutsideClose(close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") close(); }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [close]);
  return ref;
}
