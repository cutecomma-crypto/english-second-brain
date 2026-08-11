import * as db from "./db.js";
import { openDetailPanel, toast } from "./panels.js";

// 產品健檢 Phase 4：待處理／待理解 inbox（見 PRD 健檢 B）。
// 可選擇性連到內容或課程，但不強制——這是唯一需要新資料表的健檢項目。

let statusFilter = "open";
let scopeNodeId = null;
let scopeCourseId = null;

export async function renderPendingList(container, { nodeId = null, courseId = null } = {}) {
  scopeNodeId = nodeId || null;
  scopeCourseId = courseId || null;
  statusFilter = "open";

  const [scopeNode, scopeCourse] = await Promise.all([
    scopeNodeId ? db.getNode(scopeNodeId) : null,
    scopeCourseId ? db.getCourse(scopeCourseId) : null,
  ]);

  const scopeBannerHtml =
    scopeNode || scopeCourse
      ? `<div class="review-scope-banner">
          <span>🔄 這則待處理項目將連結到「${escapeHtml(scopeNode?.headword || scopeCourse?.title || "")}」</span>
          <a href="#" id="pending-scope-clear">✕ 取消連結</a>
        </div>`
      : "";

  container.innerHTML = `
    <div class="list-wrap">
      ${scopeBannerHtml}
      <div class="pending-add">
        <textarea id="pending-add-input" rows="2" placeholder="還沒想通的問題、老師說的但沒聽懂的地方……"></textarea>
        <button class="btn btn-accent" id="pending-add-btn">＋ 新增</button>
      </div>
      <div class="list-controls">
        <div class="review-source-bar" id="pending-status-bar"></div>
      </div>
      <div id="pending-results"></div>
    </div>
  `;

  container.querySelector("#pending-scope-clear")?.addEventListener("click", (e) => {
    e.preventDefault();
    scopeNodeId = null;
    scopeCourseId = null;
    renderPendingList(container);
  });

  container.querySelector("#pending-add-btn").onclick = async () => {
    const input = container.querySelector("#pending-add-input");
    const content = input.value.trim();
    if (!content) {
      toast("請先輸入問題內容");
      return;
    }
    await db.createPendingQuestion({ content, node_id: scopeNodeId, course_id: scopeCourseId });
    input.value = "";
    toast("已加入待處理");
    await paint(container);
    await updatePendingBadge();
  };

  await paint(container);
}

async function paint(container) {
  const statusBar = container.querySelector("#pending-status-bar");
  const results = container.querySelector("#pending-results");

  const [all, nodes, courses] = await Promise.all([db.listPendingQuestions(), db.listNodes(), db.listCourses()]);
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const courseMap = new Map(courses.map((c) => [c.id, c]));
  const openCount = all.filter((q) => q.status === "open").length;
  const resolvedCount = all.filter((q) => q.status === "resolved").length;

  statusBar.innerHTML = `
    <button type="button" class="review-source-btn ${statusFilter === "open" ? "active" : ""}" data-status="open">
      🕓 待處理 <strong>${openCount}</strong>
    </button>
    <button type="button" class="review-source-btn ${statusFilter === "resolved" ? "active" : ""}" data-status="resolved">
      ✓ 已解決 <strong>${resolvedCount}</strong>
    </button>
  `;
  statusBar.querySelectorAll("[data-status]").forEach((btn) => {
    btn.onclick = () => {
      if (btn.dataset.status === statusFilter) return;
      statusFilter = btn.dataset.status;
      paint(container);
    };
  });

  const filtered = all.filter((q) => q.status === statusFilter);

  if (filtered.length === 0) {
    results.innerHTML =
      statusFilter === "open"
        ? `<div class="empty-state">目前沒有待處理的問題。</div>`
        : `<div class="empty-state">還沒有已解決的問題。</div>`;
    return;
  }

  results.innerHTML = filtered
    .map((q) => {
      const node = q.node_id ? nodeMap.get(q.node_id) : null;
      const course = q.course_id ? courseMap.get(q.course_id) : null;
      const tags = `
        ${node ? `<span class="pending-tag" data-jump-node="${node.id}">🔤 ${escapeHtml(node.headword)}</span>` : ""}
        ${course ? `<span class="pending-tag" data-jump-course="${course.id}">📘 ${escapeHtml(course.title || "未命名課程")}</span>` : ""}
      `;
      const actionsHtml =
        q.status === "open"
          ? `<button class="btn btn-sm" data-resolve="${q.id}">✓ 標記已解決</button>
             <button class="btn btn-sm btn-danger" data-delete="${q.id}">刪除</button>`
          : `<button class="btn btn-sm" data-reopen="${q.id}">↺ 重新開放</button>
             <button class="btn btn-sm btn-danger" data-delete="${q.id}">刪除</button>`;

      return `
        <div class="pending-row" data-id="${q.id}">
          <div class="pending-content">${escapeHtml(q.content)}</div>
          <div class="pending-meta">
            ${tags}
            <span class="pending-date">${escapeHtml((q.status === "resolved" ? q.resolved_at : q.created_at)?.slice(0, 10) || "")}</span>
          </div>
          ${q.status === "resolved" && q.resolution_note ? `<div class="pending-resolution">💡 ${escapeHtml(q.resolution_note)}</div>` : ""}
          <div class="pending-actions" data-actions>${actionsHtml}</div>
        </div>`;
    })
    .join("");

  results.querySelectorAll("[data-jump-node]").forEach((tag) => {
    tag.onclick = () => openDetailPanel(tag.dataset.jumpNode);
  });
  results.querySelectorAll("[data-jump-course]").forEach((tag) => {
    tag.onclick = () => (location.hash = `#/course?id=${tag.dataset.jumpCourse}`);
  });
  results.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm("確定要刪除這則待處理項目嗎？")) return;
      await db.deletePendingQuestion(btn.dataset.delete);
      toast("已刪除");
      await paint(container);
      await updatePendingBadge();
    };
  });
  results.querySelectorAll("[data-reopen]").forEach((btn) => {
    btn.onclick = async () => {
      await db.reopenPendingQuestion(btn.dataset.reopen);
      toast("已重新開放");
      await paint(container);
      await updatePendingBadge();
    };
  });
  results.querySelectorAll("[data-resolve]").forEach((btn) => {
    btn.onclick = () => {
      const row = btn.closest(".pending-row");
      const actions = row.querySelector("[data-actions]");
      const id = btn.dataset.resolve;
      actions.innerHTML = `
        <div class="pending-resolve-form">
          <textarea rows="2" placeholder="想通了嗎？可以記一下是怎麼想通的（選填）"></textarea>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-accent btn-sm" data-confirm-resolve>確定</button>
            <button class="btn btn-sm" data-cancel-resolve>取消</button>
          </div>
        </div>`;
      actions.querySelector("[data-cancel-resolve]").onclick = () => paint(container);
      actions.querySelector("[data-confirm-resolve]").onclick = async () => {
        const note = actions.querySelector("textarea").value;
        await db.resolvePendingQuestion(id, note);
        toast("已標記為解決");
        await paint(container);
        await updatePendingBadge();
      };
    };
  });
}

export async function updatePendingBadge() {
  const all = await db.listPendingQuestions();
  const openCount = all.filter((q) => q.status === "open").length;
  const badge = document.getElementById("pending-badge");
  if (!badge) return;
  if (openCount > 0) {
    badge.hidden = false;
    badge.textContent = openCount;
  } else {
    badge.hidden = true;
  }
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
