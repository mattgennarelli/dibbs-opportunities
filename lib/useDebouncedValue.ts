"use client";

import { useEffect, useState } from "react";

// Returns `value`, but only after it's stopped changing for `delayMs`. Used for the search
// box: keystrokes update local state instantly (so typing feels responsive), while the URL
// (and therefore the query key that triggers a network request) only updates after the
// debounce settles.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}
