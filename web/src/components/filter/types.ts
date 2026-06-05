// Generic field-based filter system shared by /leads, /pipeline, /learners,
// /admin/programs, /admin/cohorts.
//
// Pages declare their fields once (FilterField[]) — the FilterBar UI and the
// match() function both read from the same schema, so adding a new filterable
// column is one line of config.

export type FilterFieldType = "text" | "number" | "enum" | "boolean" | "date";

export interface EnumOption {
  value: string;
  label: string;
  // Optional pill colors for richer rendering (heat, stage, status fields)
  cls?: string;
}

export interface FilterField {
  key: string;                   // unique within the surface (e.g. "score", "stage")
  label: string;                 // dropdown label ("Score", "Stage")
  type: FilterFieldType;
  options?: EnumOption[];        // required when type === "enum"
  // Reads the value off a row. Returns undefined/null if the row has nothing.
  // For dotted access we just take this function — pages can do `(row) => row.foo.bar`.
  get: (row: any) => unknown;     // eslint-disable-line @typescript-eslint/no-explicit-any
}

// Each operator declares which field types it applies to + how many values it needs.
// match() in operators.ts has the actual implementation per op.
export type OperatorKey =
  | "is" | "is_not"
  | "contains" | "not_contains"
  | "starts_with" | "ends_with"
  | "gt" | "gte" | "lt" | "lte"
  | "between"
  | "is_any_of" | "is_none_of"
  | "is_empty" | "is_not_empty";

export interface OperatorDef {
  key: OperatorKey;
  label: string;
  appliesTo: FilterFieldType[];     // which field types this operator works on
  valueArity: 0 | 1 | 2 | "many";   // 0 = no value (is_empty), 1 = single, 2 = range, "many" = chip multiselect
}

export interface FilterRule {
  id: string;                       // local uid — for keyed rendering
  fieldKey: string;
  operator: OperatorKey;
  value: unknown;                   // string | number | string[] | [number,number] | null
}

// Top-level group is implicitly AND. Inside a single-level filter bar we only
// support flat AND right now; OR happens via "is_any_of" on a single rule.
// Mixing AND/OR groups is a future extension — kept in the type to leave a door open.
export type Combinator = "and" | "or";

export interface FilterState {
  combinator: Combinator;           // top-level: how rules combine
  rules: FilterRule[];
}
