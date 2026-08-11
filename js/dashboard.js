import * as db from "./db.js";
import { summarizeToday } from "./sm2.js";
import { NODE_TYPES } from "./constants.js";
import { openEditorModal } from "./panels.js";

// 產品健檢 Phase 5：首頁／學習儀表板。純粹把 Phase 1-4 已經存在的資料組合
// 顯示，不產生任何新資料（見 PRD 健檢 B）。圖譜繼續是預設首頁，這裡是另一
// 個獨立的導覽目的地，負責「整理」，圖譜負責「探索」。

export async function renderDashboard(container) {
  const [nodes, edgeCounts, pending, courses] = await Promise.all([
    db.listNodes(),
    db.getEdgeCounts(),
    db.listPendingQuestions(),
    db.listCourses(),
  ]);

  const reviewStates = new Map(
    (await Promise.all(nodes.map(async (n) => [n.id, await db.getReviewState(n.id)]))).filter(([, rs]) => rs)
  );
  const todaySummary = summarizeToday(nodes, reviewStates, edgeCounts);

  const openPending = pending.filter((q) => q.status === "open");
  const latestCourse = courses[0] || null;

  const typeCounts = new Map(NODE_TYPES.map((t) => [t.value, 0]));
  for (const n of nodes) typeCounts.set(n.type, (typeCounts.get(n.type) || 0) + 1);
  const typeBreakdown = NODE_TYPES.filter((t) => typeCounts.get(t.value) > 0)
    .map((t) => `${typeCounts.get(t.value)} ${t.label}`)
    .join(" · ");

  container.innerHTML = `
    <div class="dashboard-wrap">
      <div class="dashboard-greeting">
        <h2>${greeting()}</h2>
        <p class="hint">今天是 ${db.todayStr()}，這是你目前的學習狀況。</p>
      </div>

      <div class="dashboard-grid">
        <div class="dashboard-card" data-goto="#/courses">
          <div class="stat-num">${courses.length}</div>
          <div class="stat-label">📘 課程記錄</div>
          <div class="stat-sub">${
            latestCourse
              ? `<span class="stat-sub-line">最近一堂：${escapeHtml(latestCourse.title || "未命名課程")}</span><span class="stat-sub-date">📅 ${escapeHtml(latestCourse.date || "")}</span>`
              : "還沒有課程記錄"
          }</div>
          <button type="button" class="btn btn-sm">查看課程</button>
        </div>

        <div class="dashboard-card" data-goto="#/pending">
          <div class="stat-num">${openPending.length}</div>
          <div class="stat-label">🕓 待處理問題</div>
          <div class="stat-sub">${openPending.length > 0 ? escapeHtml((openPending[0].content || "").slice(0, 24)) + (openPending[0].content.length > 24 ? "…" : "") : "目前沒有待處理的問題"}</div>
          <button type="button" class="btn btn-sm">查看清單</button>
        </div>

        <div class="dashboard-card" data-goto="#/review">
          <div class="stat-num">${todaySummary.dueCount}</div>
          <div class="stat-label">📅 今日到期</div>
          <div class="stat-sub">${todaySummary.needsReinforcementCount > 0 ? `另外 ${todaySummary.needsReinforcementCount} 個需要加強` : "沒有需要加強的內容"}</div>
          <button type="button" class="btn btn-accent btn-sm">開始複習</button>
        </div>

        <div class="dashboard-card" data-goto="#/nodes">
          <div class="stat-num">${nodes.length}</div>
          <div class="stat-label">🧠 內容總數</div>
          <div class="stat-sub">${typeBreakdown || "還沒有任何內容"}</div>
          <button type="button" class="btn btn-sm">瀏覽列表</button>
        </div>
      </div>

      <div class="dashboard-actions">
        <button type="button" class="btn btn-accent" id="dashboard-add">＋ 新增內容</button>
        <button type="button" class="btn" id="dashboard-graph">🔍 探索圖譜</button>
      </div>
    </div>
  `;

  container.querySelectorAll("[data-goto]").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("button")) return; // 按鈕自己有 onclick，避免雙重觸發
      location.hash = card.dataset.goto;
    });
    card.querySelector("button").onclick = () => (location.hash = card.dataset.goto);
  });

  container.querySelector("#dashboard-add").onclick = () => openEditorModal({ mode: "create" });
  container.querySelector("#dashboard-graph").onclick = () => (location.hash = "#/graph");
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "早安 👋";
  if (hour < 18) return "午安 👋";
  return "晚安 👋";
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
