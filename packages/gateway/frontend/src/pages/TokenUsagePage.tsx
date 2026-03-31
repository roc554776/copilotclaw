import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  Area,
  AreaChart,
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

const MA_WINDOW_OPTIONS = [
  { label: "None", value: undefined },
  { label: "30min", value: 1800 },
  { label: "1h", value: 3600 },
  { label: "3h", value: 10800 },
  { label: "6h", value: 21600 },
];

const MODEL_COLORS = [
  "#58a6ff", "#3fb950", "#d29922", "#f85149", "#bc8cff",
  "#79c0ff", "#56d364", "#e3b341", "#ff7b72", "#d2a8ff",
];

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function TokenUsagePage() {
  const [data, setData] = useState<TimeseriesPoint[]>([]);
  const [period, setPeriod] = useState(PERIOD_OPTIONS[2]!); // 24h default
  const [maWindow, setMaWindow] = useState<number | undefined>(3600); // 1h default
  const [loading, setLoading] = useState(true);

  const loadIdRef = useRef(0);
  const load = useCallback(async () => {
    const thisLoadId = ++loadIdRef.current;
    setLoading(true);
    try {
      const result = await fetchTokenUsageTimeseries({
        hours: period.hours,
        points: period.points,
        movingAverageWindow: maWindow,
      });
      if (thisLoadId === loadIdRef.current) {
        setData(result);
      }
    } catch {
      // Network error — show empty state
      if (thisLoadId === loadIdRef.current) {
        setData([]);
      }
    } finally {
      if (thisLoadId === loadIdRef.current) {
        setLoading(false);
      }
    }
  }, [period, maWindow]);

  useEffect(() => { load(); }, [load]);

  // Extract all model names from data
  const allModels = useMemo(() => {
    const set = new Set<string>();
    for (const point of data) {
      for (const m of point.models) set.add(m.model);
    }
    return Array.from(set).sort();
  }, [data]);

  // Transform data for recharts: flatten per-model data into columns
  const chartData = useMemo(() => {
    return data.map((point) => {
      const row: Record<string, unknown> = {
        timestamp: point.timestamp,
        time: period.hours < 24 ? formatTime(point.timestamp) : formatDateTime(point.timestamp),
        index: Math.round(point.index),
        movingAverage: point.movingAverage !== undefined ? Math.round(point.movingAverage) : undefined,
      };
      for (const model of allModels) {
        const m = point.models.find((x) => x.model === model);
        row[`${model}_total`] = m ? m.inputTokens + m.outputTokens : 0;
        row[`${model}_input`] = m ? m.inputTokens : 0;
        row[`${model}_output`] = m ? m.outputTokens : 0;
      }
      return row;
    });
  }, [data, allModels, period.hours]);

  const bg = "#0d1117";
  const cardBg = "#161b22";
  const border = "#30363d";
  const text = "#c9d1d9";
  const textMuted = "#8b949e";

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
            <button
              key={p.label}
              onClick={() => setPeriod(p)}
              style={{
                padding: "0.3rem 0.6rem",
                background: period === p ? "#58a6ff" : cardBg,
                color: period === p ? "#0d1117" : text,
                border: `1px solid ${period === p ? "#58a6ff" : border}`,
                borderRadius: "0.3rem",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", gap: "0.25rem", alignItems: "center" }}>
          <span style={{ fontSize: "0.8rem", color: textMuted }}>MA:</span>
          {MA_WINDOW_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              onClick={() => setMaWindow(opt.value)}
              style={{
                padding: "0.3rem 0.6rem",
                background: maWindow === opt.value ? "#58a6ff" : cardBg,
                color: maWindow === opt.value ? "#0d1117" : text,
                border: `1px solid ${maWindow === opt.value ? "#58a6ff" : border}`,
                borderRadius: "0.3rem",
                cursor: "pointer",
                fontSize: "0.8rem",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          style={{
            padding: "0.3rem 0.6rem",
            background: cardBg,
            color: text,
            border: `1px solid ${border}`,
            borderRadius: "0.3rem",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          Refresh
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
                  formatter={(v: number) => v.toLocaleString()}
                />
                <Line type="monotone" dataKey="index" stroke="#58a6ff" strokeWidth={2} dot={false} name="Index" />
                {maWindow !== undefined && (
                  <Line type="monotone" dataKey="movingAverage" stroke="#d29922" strokeWidth={2} strokeDasharray="5 5" dot={false} name="Moving Avg" />
                )}
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Per-model Token Usage Chart */}
          <div style={{ background: cardBg, border: `1px solid ${border}`, borderRadius: "0.5rem", padding: "1rem" }}>
            <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem 0" }}>Token Usage by Model</h2>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke={border} />
                <XAxis dataKey="time" stroke={textMuted} fontSize={11} />
                <YAxis stroke={textMuted} fontSize={11} tickFormatter={(v: number) => v.toLocaleString()} />
                <Tooltip
                  contentStyle={{ background: cardBg, border: `1px solid ${border}`, color: text, fontSize: "0.8rem" }}
                  labelStyle={{ color: textMuted }}
                  formatter={(v: number) => v.toLocaleString()}
                />
                {allModels.map((model, i) => (
                  <Area
                    key={model}
                    type="monotone"
                    dataKey={`${model}_total`}
                    stackId="tokens"
                    fill={MODEL_COLORS[i % MODEL_COLORS.length]!}
                    stroke={MODEL_COLORS[i % MODEL_COLORS.length]!}
                    fillOpacity={0.6}
                    name={model}
                  />
                ))}
                <Legend />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
    </div>
  );
}
