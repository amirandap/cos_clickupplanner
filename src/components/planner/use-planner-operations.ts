"use client";

import { useCallback, useRef, useState } from "react";
import type { PlannerData } from "@/lib/planner/types";
import { createOperationRunner, createScheduleClient, isPlannerData, requestJson, type OperationResult } from "./client";

type VisibleRange = { start: string; end: string };

export function usePlannerOperations(initialData: PlannerData) {
  const [data, setData] = useState(initialData);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const rangeRef = useRef<VisibleRange | null>(null);
  const requestRef = useRef(0);
  const busyRef = useRef(false);
  const [runner] = useState(createOperationRunner);
  const [scheduleClient] = useState(createScheduleClient);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    const range = rangeRef.current;
    const query = range ? `?${new URLSearchParams(range)}` : "";
    try {
      const next = await requestJson(`/api/planner${query}`, {}, isPlannerData);
      if (requestId === requestRef.current) setData(next);
    } catch (cause) {
      if (requestId === requestRef.current) throw cause;
    }
  }, []);

  const loadRange = useCallback((range: VisibleRange) => {
    rangeRef.current = range;
    void refresh().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : "No se pudo cargar el calendario. Intenta de nuevo.");
    });
  }, [refresh]);

  const run = useCallback(async (operation: () => Promise<OperationResult>, onSaved?: () => void) => {
    if (busyRef.current) return false;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      const outcome = await runner.run(operation, refresh);
      if (!outcome) return false;
      setError(outcome.error);
      const result = outcome.result;
      setWarning(result?.warning ?? (result && "clickupSyncPending" in result && result.clickupSyncPending
        ? "El cambio se guardó en el calendario. Queda pendiente actualizarlo en ClickUp."
        : null));
      if (outcome.saved) onSaved?.();
      return outcome.saved;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [refresh, runner]);

  return { data, busy, error, warning, setError, setWarning, loadRange, run, schedule: scheduleClient.schedule };
}
