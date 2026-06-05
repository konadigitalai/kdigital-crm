"use client";

import { useMemo, useState } from "react";
import { applyFilter } from "./operators";
import type { FilterField, FilterState } from "./types";

const EMPTY_STATE: FilterState = { combinator: "and", rules: [] };

// Hook: keep filter state, return [filtered rows, state, setState].
// Pages do:
//   const [filtered, state, setState] = useFilter(rows, FIELDS);
//   <FilterBar fields={FIELDS} state={state} onChange={setState} />
//   <Table rows={filtered} />
export function useFilter<T>(
  rows: T[],
  fields: FilterField[],
): [T[], FilterState, (s: FilterState) => void] {
  const [state, setState] = useState<FilterState>(EMPTY_STATE);
  const filtered = useMemo(() => applyFilter(state, rows, fields), [state, rows, fields]);
  return [filtered, state, setState];
}
