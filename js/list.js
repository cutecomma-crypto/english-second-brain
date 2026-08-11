import * as db from "./db.js";
import { NODE_TYPES, typeLabel, wordRowMeta } from "./constants.js";
import { openDetailPanel } from "./panels.js";

let query = "";
let typeFilter = "all";

export async function renderList(container) {
  container.innerHTML = `
    <div class="list-wrap">
      <div class="list-controls">
        <input type="text" id="list-search" placeholder="搜尋 headword 或翻譯…" value="${escapeAttr(query)}" />
        <select id="list-type">
          <option value="all">全部類型</option>
          ${NODE_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join("")}
        </select>
      </div>
      <div class="list-summary" id="list-summary"></div>
      <div class="list-result-count" id="list-result-count"></div>
      <div id="list-results"></div>
    </div>
  `;
  container.querySelector("#list-search").value = query;
  container.querySelector("#list-type").value = typeFilter;

  container.querySelector("#list-search").oninput = (e) => {
    query = e.target.value;
    paint(container);
  };
  container.querySelector("#list-type").onchange = (e) => {
    typeFilter = e.target.value;
    paint(container);
  };

  await paint(container);
}

async function paint(container) {
  const results = container.querySelector("#list-results");
  const summaryEl = container.querySelector("#list-summary");
  const countEl = container.querySelector("#list-result-count");
  const [allNodes, searchedNodes] = await Promise.all([db.listNodes(), db.searchNodes(query)]);
  const filtered = typeFilter === "all" ? searchedNodes : searchedNodes.filter((n) => n.type === typeFilter);

  // 總數統計不受搜尋字或篩選影響，永遠反映整個收藏的組成，同時當篩選捷徑用。
  const typeCounts = new Map(NODE_TYPES.map((t) => [t.value, 0]));
  for (const n of allNodes) typeCounts.set(n.type, (typeCounts.get(n.type) || 0) + 1);
  summaryEl.innerHTML = `
    <button type="button" class="list-count-chip ${typeFilter === "all" ? "active" : ""}" data-count-filter="all">
      全部 <strong>${allNodes.length}</strong>
    </button>
    ${NODE_TYPES.map(
      (t) => `<button type="button" class="list-count-chip ${typeFilter === t.value ? "active" : ""}" data-count-filter="${t.value}">
        ${t.label} <strong>${typeCounts.get(t.value) || 0}</strong>
      </button>`
    ).join("")}
  `;
  summaryEl.querySelectorAll("[data-count-filter]").forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.countFilter === typeFilter) return;
      typeFilter = btn.dataset.countFilter;
      container.querySelector("#list-type").value = typeFilter;
      paint(container);
    };
  });

  countEl.textContent = query.trim() || typeFilter !== "all" ? `顯示 ${filtered.length} 筆` : "";

  if (filtered.length === 0) {
    results.innerHTML = `<div class="empty-state">找不到符合的內容。</div>`;
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = await Promise.all(
    filtered.map(async (n) => {
      const rs = await db.getReviewState(n.id);
      const overdue = rs && rs.due_at <= today;
      return { n, overdue };
    })
  );
  rows.sort((a, b) => (b.overdue - a.overdue) || a.n.headword.localeCompare(b.n.headword));

  results.innerHTML = rows
    .map(({ n, overdue }) => {
      const { pos, translation } = wordRowMeta(n);
      return `
      <div class="node-row list-node-row ${n.type === "grammar" ? "list-node-row-full" : ""}" data-open="${n.id}">
        <span class="overdue-marker">${overdue ? `<span class="overdue-dot" title="已到期"></span>` : ""}</span>
        <span class="type-badge type-${n.type}">${typeLabel(n.type)}</span>
        <strong class="list-node-headword">${escapeHtml(n.headword)}</strong>
        <span class="list-node-pos">${escapeHtml(pos)}</span>
        <span class="list-node-translation">${escapeHtml(translation)}</span>
      </div>`;
    })
    .join("");

  results.querySelectorAll("[data-open]").forEach((row) => {
    row.onclick = () => openDetailPanel(row.dataset.open);
  });
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(str) {
  return escapeHtml(str);
}
