import type { UserInput } from "./store.js";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderRow(input: UserInput): string {
  const reply = input.reply
    ? `<td>${escapeHtml(input.reply.message)}</td><td>${escapeHtml(input.reply.createdAt)}</td>`
    : `<td class="pending">waiting…</td><td></td>`;
  return `<tr>
    <td>${escapeHtml(input.id)}</td>
    <td>${escapeHtml(input.message)}</td>
    <td>${escapeHtml(input.createdAt)}</td>
    ${reply}
  </tr>`;
}

export function renderDashboard(inputs: UserInput[]): string {
  const rows = inputs.map(renderRow).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>copilotclaw gateway</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }
    h1 { color: #58a6ff; }
    table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
    th, td { border: 1px solid #30363d; padding: 0.5rem 0.75rem; text-align: left; }
    th { background: #161b22; color: #8b949e; }
    tr:hover { background: #161b22; }
    .pending { color: #8b949e; font-style: italic; }
    code { background: #161b22; padding: 0.15rem 0.3rem; border-radius: 3px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>copilotclaw gateway</h1>
  <table>
    <thead>
      <tr><th>ID</th><th>User Input</th><th>Input At</th><th>Reply</th><th>Reply At</th></tr>
    </thead>
    <tbody>
      ${rows || '<tr><td colspan="5" class="pending">No inputs yet</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
}
