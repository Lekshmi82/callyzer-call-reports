import { formatDuration } from "../lib/format.js";
import { html, raw } from "../lib/html.js";
import type { Metrics, PersonRow, ReportModel } from "./metrics.js";

/**
 * Standalone HTML for the report image (rendered by headless Chromium at 2x).
 * Layout mirrors the reference screenshot: title, subtitle, six summary cards,
 * employee table with a Team row, and a caveats footer.
 */
const CSS = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #ffffff; }
body { font-family: Inter, "Segoe UI", Roboto, "Noto Sans", "Liberation Sans", Arial, sans-serif; color: #141414;
  -webkit-font-smoothing: antialiased; font-feature-settings: "tnum" 1, "cv11" 1; }
#report { width: 800px; padding: 22px 17px 16px; position: relative; overflow: hidden; background: #fff; }
h1 { font-size: 19px; font-weight: 700; letter-spacing: -0.2px; }
.sub { margin-top: 3px; font-size: 11.5px; color: #5f6368; }
.cards { margin-top: 13px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
.card { background: #e9f1fb; border-radius: 8px; padding: 9px 10px 10px; }
.card .v { font-size: 17.5px; font-weight: 700; letter-spacing: -0.2px; }
.card .v small { font-size: 10.5px; font-weight: 600; color: #4a4f57; margin-left: 2px; }
.card .l { margin-top: 5px; font-size: 8.5px; letter-spacing: 0.5px; text-transform: uppercase; color: #5b6470; }
table { margin-top: 12px; width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #e3e3e3; }
th { background: #f6f5f3; font-weight: 600; color: #4a4a4a; font-size: 9.5px; line-height: 1.25; padding: 8px 5px 6px;
  text-align: center; vertical-align: bottom; border-right: 1px solid #e6e6e6; border-bottom: 1.5px solid #222; }
th:first-child { text-align: left; padding-left: 8px; }
td { padding: 6px 5px; text-align: center; border-right: 1px solid #ececec; border-bottom: 1px solid #ececec; white-space: nowrap; }
td:first-child { text-align: left; padding-left: 8px; font-weight: 600; font-size: 11.5px; }
th:last-child, td:last-child { border-right: none; }
td .ph { font-weight: 400; font-size: 8.5px; color: #777; margin-left: 3px; }
td.conn { color: #1f4f9e; font-weight: 700; }
td.conn .pct { color: #7b8794; font-weight: 500; font-size: 8.5px; margin-left: 3px; }
tr.idle td { color: #9a9a9a; }
tr.idle td:first-child { font-weight: 500; color: #8a8a8a; }
tr.idle td.conn { color: #1f4f9e; }
tr.team td { background: #f3f3f2; font-weight: 700; border-top: 1px solid #d5d5d5; border-bottom: none; }
tr.team td.conn { color: #1f4f9e; }
.foot { margin-top: 9px; border-top: 1px solid #e3e3e3; padding-top: 7px; font-size: 8.5px; color: #666; line-height: 1.5; }
.foot .gen { color: #8a8a8a; margin-top: 2px; }
.wm { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
.wm span { transform: rotate(-18deg); font-size: 64px; font-weight: 800; color: rgba(220, 38, 38, 0.13); letter-spacing: 4px; }
`;

/** Durations without seconds: "2h 30m", "43m"; under a minute shows "<1m". */
const dur = (s: number) => (s > 0 && s < 60 ? "<1m" : formatDuration(Math.round(s / 60) * 60, { seconds: false }));
const durShort = dur;

function cells(m: Metrics) {
  return html`
    <td>${m.totalCalls}</td>
    <td>${dur(m.totalDuration)}</td>
    <td class="conn">${m.connectedCalls}${m.totalCalls > 0 ? html`<span class="pct">${m.connectedPct}%</span>` : ""}</td>
    <td>${dur(m.connectedDuration)}</td>
    <td>${formatDuration(m.avgConnected)}</td>
    <td>${m.uniqueClients}</td>
    <td>${m.uniqueConnected}</td>`;
}

function personRow(r: PersonRow) {
  const phones = r.phones > 1 ? html`<span class="ph">${r.phones} phones</span>` : "";
  if (!r.active) {
    const dot = raw("<td>·</td>");
    return html`<tr class="idle"><td>${r.name}${phones}</td>${dot}${dot}<td class="conn">·</td>${dot}${dot}${dot}${dot}</tr>`;
  }
  return html`<tr><td>${r.name}${phones}</td>${cells(r)}</tr>`;
}

export function renderReportHtml(m: ReportModel): string {
  const t = m.team;
  const sample = m.source === "sample";
  const body = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${m.title}</title><style>${raw(CSS)}</style></head>
<body><div id="report">
  <h1>${m.title} · ${m.dateLabel}</h1>
  <div class="sub">${sample ? "SAMPLE DATA (not real) · " : "Callyzer · "}Today so far, as of ${m.asOfLabel} IST</div>
  <table>
    <thead><tr>
      <th style="width:22%">Employee</th><th>Total Calls</th><th>Total Duration</th><th>Connected Calls</th>
      <th>Conn. Calls Duration</th><th>Conn. Call Avg. Duration</th>
      <th>Unique Clients</th><th>Unique Conn. Calls</th>
    </tr></thead>
    <tbody>
      ${m.rows.map(personRow)}
      <tr class="team"><td>Team</td>${cells(t)}</tr>
    </tbody>
  </table>
  <div class="foot">
    ${m.footnotes.map((f) => html`<div>${f}</div>`)}
    <div class="gen">Generated ${m.generatedAtLabel} IST · ${m.dateLabel}</div>
  </div>
  ${sample ? html`<div class="wm"><span>SAMPLE DATA</span></div>` : ""}
</div></body></html>`;
  return body.value;
}

/** Short text for the WhatsApp message body / summary parameter. */
export function summaryLine(m: ReportModel): string {
  const t = m.team;
  return `${t.totalCalls} calls, ${t.connectedCalls} connected (${t.connectedPct}%), talk time ${durShort(t.connectedDuration)}`;
}
