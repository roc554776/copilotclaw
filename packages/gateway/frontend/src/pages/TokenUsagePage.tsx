import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { type TimeseriesPoint, fetchTokenUsageTimeseries } from "../api";

const PERIOD_OPTIONS = [
  { label: "1h", hours: 1, points: 12 },
  { label: "6h", hours: 6, points: 36 },
  { label: "24h", hours: 24, points: 48 },
  { label: "3d", hours: 72, points: 72 },
  { label: "7d", hours: 168, points: 84 },
];

const MA_WINDOW_OPTIONS: Array<{ label: string; value: number | null }> = [
  { label: "None", value: null },
  { label: "30min", value: 1800 },
  { label: "1h", value: 3600 },
  { label: "3h", value: 10800 },
  { label: "5h", value: 18000 },
  { label: "6h", value: 21600 },
];

const MODEL_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff",
  "#79c0ff", "#56d364", "#e3b341", "#ff7b72", "#d2a8ff",
];

const AUTO_REFRESH_INTERVAL_MS = 60_000;

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function findPeriod(hours: number) {
  return PERIOD_OPTIONS.find((p) => p.hours === hours) ?? PERIOD_OPTIONS[2]!;
}


export function TokenUsagePage() {
  const [searchParams, setSearchParams] = useSearchParams();

  // Restore state from query params
  const initialPeriod = findPeriod(Number(searchParams.get("hours")) || 24);
  const initialMaRaw = searchParams.get("ma");
  const initialMa = initialMaRaw === null ? 18000 : initialMaRaw === "none" ? null : Number(initialMaRaw) || null;
  const initialAutoRefresh = searchParams.get("autoRefresh") !== "off";

  const [data, setData] = useState<TimeseriesPoint[]>([]);
  const [period, setPeriod] = useState(initialPeriod);
  const [maWindow, setMaWindow] = useState<number | null>(initialMa);
  const [loading, setLoading] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(initialAutoRefresh);

  // Sync state to query params
  useEffect(() => {
    const params: Record<string, string> = { hours: String(period.hours) };
    if (maWindow !== null) params.ma = String(maWindow);
    else params.ma = "none";
    if (!autoRefresh) params.autoRefresh = "off";
    setSearchParams(params, { replace: true });
  }, [period, maWindow, autoRefresh, setSearchParams]);

  const loadIdRef = useRef(0);
  const load = useCallback(async () => {
    const thisLoadId = ++loadIdRef.current;
    setLoading(true);
    try {
      const result = await fetchTokenUsageTimeseries({
        hours: period.hours,
        points: period.points,
        movingAverageWindow: maWindow ?? undefined,
      });
      if (thisLoadId === loadIdRef.current) setData(result);
    } catch {
      if (thisLoadId === loadIdRef.current) setData([]);
    } finally {
      if (thisLoadId === loadIdRef.current) setLoading(false);
    }
  }, [period, maWindow]);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh: use ref to always call the latest load without restarting the timer
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => { loadRef.current(); }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [autoRefresh]);

  const allModels = useMemo(() => {
    const set = new Set<string>();
    for (const point of data) {
      for (const m of point.models) set.add(m.model);
    }
    return Array.from(set).sort();
  }, [data]);

  // Per-model moving averages computed client-side from per-model consumed tokens
  const perModelMa = useMemo(() => {
    if (maWindow === null || data.length === 0) return null;
    const bucketMs = data.length >= 2
      ? new Date(data[1]!.timestamp).getTime() - new Date(data[0]!.timestamp).getTime()
      : 1;
    const windowBuckets = Math.max(1, Math.round((maWindow * 1000) / bucketMs));

    const result: Array<Record<string, number>> = [];
    for (let i = 0; i < data.length; i++) {
      const row: Record<string, number> = {};
      for (const model of allModels) {
        let sum = 0;
        const start = Math.max(0, i - windowBuckets + 1);
        for (let j = start; j <= i; j++) {
          const m = data[j]!.models.find((x) => x.model === model);
          if (m) sum += (m.inputTokens - m.cacheReadTokens) + (m.outputTokens - m.cacheWriteTokens);
        }
        row[model] = sum / windowBuckets;
      }
      result.push(row);
    }
    return result;
  }, [data, allModels, maWindow]);

  const chartData = useMemo(() => {
    return data.map((point, i) => {
      const row: Record<string, unknown> = {
        timestamp: point.timestamp,
        time: period.hours < 24 ? formatTime(point.timestamp) : formatDateTime(point.timestamp),
        index: Math.round(point.index),
        movingAverage: point.movingAverage !== undefined ? Math.round(point.movingAverage) : undefined,
      };
      for (const model of allModels) {
        const m = point.models.find((x) => x.model === model);
        const consumed = m ? (m.inputTokens - m.cacheReadTokens) + (m.outputTokens - m.cacheWriteTokens) : 0;
        row[`${model}_consumed`] = consumed;
        if (perModelMa !== null) {
          row[`${model}_ma`] = Math.round(perModelMa[i]![model] ?? 0);
        }
      }
      return row;
    });
  }, [data, allModels, period.hours, perModelMa]);

  const bg = "#0d1117";
  const cardBg = "#161b22";
  const border = "#30363d";
  const text = "#c9d1d9";
  const textMuted = "#8b949e";

  const btnStyle = (active: boolean) => ({
    padding: "0.3rem 0.6rem",
    background: active ? "#58a6ff" : cardBg,
    color: active ? "#0d1117" : text,
    border: `1px solid ${active ? "#58a6ff" : border}`,
    borderRadius: "0.3rem",
    cursor: "pointer" as const,
    fontSize: "0.8rem",
  });

  return (
    <div style={{ background: bg, color: text, minHeight: "100vh", padding: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.3rem" }}>Token Usage</h1>
        <Link to="/" style={{ color: "#58a6ff", textDecoration: "none", fontSize: "0.85rem" }}>← Dashboard</Link>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: "1rem", marginBottom: "1rem", flexWrap: "wrap", alignItems: "center" }}>
        <div style={{ display: "flex", gap: "0.25rem" }}>
          {PERIOD_OPTIONS.map((p) => (
            <button key={p.label} onClick={() => setPeriod(p)} style={btnStyle(period === p)}>{p.label}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.8rem", color: textMuted }}>MA:</span>
          {MA_WINDOW_OPTIONS.map((opt) => (
            <button key={opt.label} onClick={() => setMaWindow(opt.value)} style={btnStyle(maWindow === opt.value)}>{opt.label}</button>
          ))}
        </div>
        <button onClick={load} style={btnStyle(false)}>Refresh</button>
        <button
          onClick={() => setAutoRefresh((v) => !v)}
          style={btnStyle(autoRefresh)}
        >
          Auto {autoRefresh ? "ON" : "OFF"}
        </button>
      </div>

      {loading && <div style={{ color: textMuted, padding: "2rem", textAlign: "center" }}>Loading...</div>}

      {!loading && chartData.length === 0 && (
        <div style={{ color: textMuted, padding: "2rem", textAlign: "center" }}>No data for the selected period.</div>
      )}

      {!loading && chartData.length > 0 && (
        <>
          {/* Index Chart */}
          <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: "0.5rem", padding: "1rem", marginBottom: "1rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem 0" }}>Token Consumption Index</h2>
            <ResponsiveContainer width="100%" height={250}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={border} />
                <XAxis dataKey="time" stroke={textMuted} fontSize={11} />
                <YAxis stroke={textMuted} fontSize={11} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip
                  contentStyle={{ background: cardBg, border: `1px solid ${border}`, color: text, fontSize: "0.8rem" }}
                  labelStyle={{ color: textMuted }}
                  formatter={(v) => typeof v === "number" ? v.toLocaleString() : String(v ?? "")}
                />
                <Line type="monotone" dataKey="index" stroke="#58a6ff" strokeWidth={2} dot={false} name="Index" />
                {maWindow !== null && (
                  <Line type="monotone" dataKey="movingAverage" stroke="#d29922" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Moving Avg" />
                )}
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Per-model Token Usage Chart — line only, no fill */}
          <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: "0.5rem", padding: "1rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem 0" }}>Consumed Tokens by Model</h2>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={border} />
                <XAxis dataKey="time" stroke={textMuted} fontSize={11} />
                <YAxis stroke={textMuted} fontSize={11} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip
                  contentStyle={{ background: cardBg, border: `1px solid ${border}`, color: text, fontSize: "0.8rem" }}
                  labelStyle={{ color: textMuted }}
                  formatter={(v) => typeof v === "number" ? v.toLocaleString() : String(v ?? "")}
                />
                {allModels.map((model, i) => (
                  <Line
                    key={`${model}_consumed`}
                    type="monotone"
                    dataKey={`${model}_consumed`}
                    stroke={MODEL_COLORS[i % MODEL_COLORS.length]!}
                    strokeWidth={2}
                    dot={false}
                    name={model}
                  />
                ))}
                {maWindow !== null && allModels.map((model, i) => (
                  <Line
                    key={`${model}_ma`}
                    type="monotone"
                    dataKey={`${model}_ma`}
                    stroke={MODEL_COLORS[i % MODEL_COLORS.length]!}
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    name={`${model} MA`}
                  />
                ))}
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
