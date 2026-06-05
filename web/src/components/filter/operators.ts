// Operator catalog + the match() function.
// match(rule, row, field) returns true if the row passes the rule.
// The combinator (AND/OR) lives in the hook, not here — match() works on a single rule.

import type {
  Combinator, FilterField, FilterFieldType, FilterRule, FilterState, OperatorDef, OperatorKey,
} from "./types";

export const OPERATORS: Record<OperatorKey, OperatorDef> = {
  is:            { key: "is",            label: "is",          appliesTo: ["text", "number", "enum", "boolean", "date"], valueArity: 1 },
  is_not:        { key: "is_not",        label: "is not",      appliesTo: ["text", "number", "enum", "boolean", "date"], valueArity: 1 },
  contains:      { key: "contains",      label: "contains",    appliesTo: ["text"],                                       valueArity: 1 },
  not_contains:  { key: "not_contains",  label: "doesn't contain", appliesTo: ["text"],                                   valueArity: 1 },
  starts_with:   { key: "starts_with",   label: "starts with", appliesTo: ["text"],                                       valueArity: 1 },
  ends_with:     { key: "ends_with",     label: "ends with",   appliesTo: ["text"],                                       valueArity: 1 },
  gt:            { key: "gt",            label: ">",           appliesTo: ["number", "date"],                             valueArity: 1 },
  gte:           { key: "gte",           label: "≥",           appliesTo: ["number", "date"],                             valueArity: 1 },
  lt:            { key: "lt",            label: "<",           appliesTo: ["number", "date"],                             valueArity: 1 },
  lte:           { key: "lte",           label: "≤",           appliesTo: ["number", "date"],                             valueArity: 1 },
  between:       { key: "between",       label: "between",     appliesTo: ["number", "date"],                             valueArity: 2 },
  is_any_of:     { key: "is_any_of",     label: "is any of",   appliesTo: ["enum", "text"],                               valueArity: "many" },
  is_none_of:    { key: "is_none_of",    label: "is none of",  appliesTo: ["enum", "text"],                               valueArity: "many" },
  is_empty:      { key: "is_empty",      label: "is empty",    appliesTo: ["text", "number", "enum", "boolean", "date"], valueArity: 0 },
  is_not_empty:  { key: "is_not_empty",  label: "is not empty",appliesTo: ["text", "number", "enum", "boolean", "date"], valueArity: 0 },
};

export function operatorsForType(t: FilterFieldType): OperatorDef[] {
  return Object.values(OPERATORS).filter((op) => op.appliesTo.includes(t));
}

// Default operator the bar selects when you pick a fresh field.
export function defaultOperator(t: FilterFieldType): OperatorKey {
  switch (t) {
    case "text":    return "contains";
    case "number":  return "gte";
    case "enum":    return "is_any_of";
    case "boolean": return "is";
    case "date":    return "gte";
  }
}

// Default value for a fresh rule (used when you pick a new field).
export function defaultValue(op: OperatorKey, type: FilterFieldType): unknown {
  const def = OPERATORS[op];
  if (def.valueArity === 0)      return null;
  if (def.valueArity === "many") return [];
  if (def.valueArity === 2)      return type === "number" ? [0, 100] : [null, null];
  if (type === "boolean")        return true;
  if (type === "number")         return null;
  return "";
}

function toLowerStr(v: unknown): string {
  if (v == null) return "";
  return String(v).toLowerCase();
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Single-rule predicate.
function matchOne(rule: FilterRule, row: unknown, field: FilterField): boolean {
  const left = field.get(row);
  const op = rule.operator;
  const v = rule.value;

  // Empty checks first — they're type-agnostic.
  if (op === "is_empty")     return left == null || left === "" || (Array.isArray(left) && left.length === 0);
  if (op === "is_not_empty") return !(left == null || left === "" || (Array.isArray(left) && left.length === 0));

  // Bail if the row's value is missing — every other op requires presence.
  if (left == null) return false;

  switch (op) {
    case "is":           return field.type === "number" ? toNum(left) === toNum(v) : String(left) === String(v);
    case "is_not":       return field.type === "number" ? toNum(left) !== toNum(v) : String(left) !== String(v);
    case "contains":     return toLowerStr(left).includes(toLowerStr(v));
    case "not_contains": return !toLowerStr(left).includes(toLowerStr(v));
    case "starts_with":  return toLowerStr(left).startsWith(toLowerStr(v));
    case "ends_with":    return toLowerStr(left).endsWith(toLowerStr(v));
    case "gt": {
      const a = toNum(left); const b = toNum(v);
      return a != null && b != null && a > b;
    }
    case "gte": {
      const a = toNum(left); const b = toNum(v);
      return a != null && b != null && a >= b;
    }
    case "lt": {
      const a = toNum(left); const b = toNum(v);
      return a != null && b != null && a < b;
    }
    case "lte": {
      const a = toNum(left); const b = toNum(v);
      return a != null && b != null && a <= b;
    }
    case "between": {
      const a = toNum(left);
      const range = Array.isArray(v) ? v : [];
      const lo = toNum(range[0]); const hi = toNum(range[1]);
      if (a == null || lo == null || hi == null) return false;
      return a >= lo && a <= hi;
    }
    case "is_any_of": {
      const list = Array.isArray(v) ? v.map(String) : [];
      if (list.length === 0) return true; // empty multiselect → no constraint, pass
      return list.includes(String(left));
    }
    case "is_none_of": {
      const list = Array.isArray(v) ? v.map(String) : [];
      if (list.length === 0) return true;
      return !list.includes(String(left));
    }
  }

  return true;
}

// Apply a full FilterState to an array of rows.
export function applyFilter<T>(state: FilterState, rows: T[], fields: FilterField[]): T[] {
  // No active rules → don't filter.
  const active = state.rules.filter((r) => isRuleComplete(r));
  if (active.length === 0) return rows;
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  return rows.filter((row) => testRow(state.combinator, active, row, fieldByKey));
}

function testRow<T>(
  combinator: Combinator,
  rules: FilterRule[],
  row: T,
  fieldByKey: Map<string, FilterField>,
): boolean {
  if (combinator === "and") {
    return rules.every((r) => {
      const f = fieldByKey.get(r.fieldKey);
      return f ? matchOne(r, row, f) : true;
    });
  }
  return rules.some((r) => {
    const f = fieldByKey.get(r.fieldKey);
    return f ? matchOne(r, row, f) : false;
  });
}

// Is this rule actually configured enough to filter on?
// Empty values (e.g. empty text input) → treat the rule as inactive so the user
// sees their filter chip without losing all rows while typing.
export function isRuleComplete(rule: FilterRule): boolean {
  const op = OPERATORS[rule.operator];
  if (!op) return false;
  if (op.valueArity === 0) return true;
  const v = rule.value;
  if (op.valueArity === "many") return Array.isArray(v) && v.length > 0;
  if (op.valueArity === 2) {
    if (!Array.isArray(v)) return false;
    return v[0] !== null && v[0] !== "" && v[1] !== null && v[1] !== "";
  }
  return v !== null && v !== undefined && v !== "";
}
