import * as db from "./db.js";
import { GraphView } from "./graph.js";
import { renderReview, updateDueBadge } from "./review.js";
import { renderList } from "./list.js";
import { renderCourseList, renderCourseLearningPage } from "./courses.js";
import { renderPendingList, updatePendingBadge } from "./pending.js";
import { renderDashboard } from "./dashboard.js";
import { openDetailPanel, openEditorModal, setRefreshHandler, toast } from "./panels.js";
import { typeLabel, grammarPreviewText } from "./constants.js";

const viewDashboard = document.getElementById("view-dashboard");
const viewGraph = document.getElementById("view-graph");
const viewReview = document.getElementById("view-review");
const viewNodes = document.getElementById("view-nodes");
const viewCourses = document.getElementById("view-courses");
const viewCourse = document.getElementById("view-course");
const viewPending = document.getElementById("view-pending");
const views = {
  dashboard: viewDashboard,
  graph: viewGraph,
  review: viewReview,
  nodes: viewNodes,
  courses: viewCourses,
  course: viewCourse,
  pending: viewPending,
};

let graphView = null;
// 圖譜第二階段：預設只顯示一階關係，逐層探索，而不是一次攤開整張圖。
// null = 顯示整張圖；有值 = 正在以這個內容為中心探索。
let focusNodeId = null;
let focusDepth = 1; // 每次重新聚焦都從一階開始，使用者主動「展開下一層」才變 2
let focusHistory = []; // 「上一步」用的堆疊，記錄探索路徑
const MAX_FOCUS_DEPTH = 2;

function currentRoute() {
  const hash = location.hash.replace(/^#\//, "").split("?")[0];
  return ["dashboard", "graph", "review", "nodes", "courses", "course", "pending"].includes(hash) ? hash : "graph";
}

async function router() {
  const route = currentRoute();
  document.querySelectorAll(".nav-chip").forEach((chip) => {
    const isActive = chip.dataset.route === route || (chip.dataset.route === "courses" && route === "course");
    chip.classList.toggle("active", isActive);
  });
  Object.entries(views).forEach(([name, el]) => (el.hidden = name !== route));

  if (route === "dashboard") await renderDashboard(viewDashboard);
  else if (route === "graph") await paintGraph();
  else if (route === "review") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    await renderReview(viewReview, { courseId: params.get("course") });
  } else if (route === "nodes") await renderList(viewNodes);
  else if (route === "courses") await renderCourseList(viewCourses);
  else if (route === "course") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    const courseId = params.get("id");
    if (courseId) await renderCourseLearningPage(viewCourse, courseId);
  } else if (route === "pending") {
    const params = new URLSearchParams(location.hash.split("?")[1] || "");
    await renderPendingList(viewPending, { nodeId: params.get("for_node"), courseId: params.get("for_course") });
  }

  const params = new URLSearchParams(location.hash.split("?")[1] || "");
  const nodeId = params.get("node");
  if (nodeId) openDetailPanel(nodeId);
}

function handleGraphNodeClick(id) {
  // 課程是運算出來的虛擬節點，沒有「詳情面板」——直接導到課程頁，
  // 跟課程頁本身「導覽而非覆蓋層」的設計一致。
  const clicked = graphView?.byId.get(id);
  if (clicked?.type === "course") {
    location.hash = `#/course?id=${id}`;
    return;
  }
  openDetailPanel(id);
  // 點擊內容會自動以它為中心重新聚焦，不需要先手動開啟「聚焦模式」——
  // 這樣圖譜在資料量變大時，預設行為就是逐層探索，不是整張圖攤開。
  if (focusNodeId && focusNodeId !== id) focusHistory.push(focusNodeId);
  focusNodeId = id;
  focusDepth = 1;
  paintGraph();
}

// 純前端 BFS：從中心內容出發，走 depth 步以內能到達的內容與關聯，其餘先不畫。
// 不需要新資料表，只是對既有 Edge 做一次圖走訪（見產品健檢 E · Focus Mode）。
function bfsSubgraph(centerId, nodes, edges, depth) {
  const adjacency = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of edges) {
    adjacency.get(e.from_node_id)?.add(e.to_node_id);
    adjacency.get(e.to_node_id)?.add(e.from_node_id);
  }
  const visited = new Set([centerId]);
  let frontier = [centerId];
  for (let step = 0; step < depth; step++) {
    const next = [];
    for (const id of frontier) {
      for (const neighborId of adjacency.get(id) || []) {
        if (!visited.has(neighborId)) {
          visited.add(neighborId);
          next.push(neighborId);
        }
      }
    }
    frontier = next;
  }
  return {
    nodes: nodes.filter((n) => visited.has(n.id)),
    edges: edges.filter((e) => visited.has(e.from_node_id) && visited.has(e.to_node_id)),
  };
}

async function paintGraph() {
  const { nodes, edges } = await db.getGraphData();

  if (nodes.length === 0) {
    viewGraph.innerHTML = `
      <div class="graph-empty">
        <div style="font-size:2.4rem;">🧠</div>
        <h2 style="margin:0;">還沒有任何內容</h2>
        <p>新增第一個單字或片語，開始建立你的英文知識網路。建立時系統會建議你把它跟既有內容連起來。</p>
        <button class="btn btn-accent" id="empty-add">＋ 新增第一個內容</button>
      </div>`;
    viewGraph.querySelector("#empty-add").onclick = () => openEditorModal({ mode: "create" });
    return;
  }

  if (focusNodeId && !nodes.some((n) => n.id === focusNodeId)) {
    focusNodeId = null;
    focusHistory = [];
  }

  if (!viewGraph.querySelector("canvas")) {
    viewGraph.innerHTML = `
      <div class="graph-toolbar">
        <span>🖱️ 拖曳調整位置・點擊內容開始聚焦探索・點擊課程可以直接進入</span>
      </div>
      <div id="focus-banner"></div>
      <canvas id="graph-canvas"></canvas>
      <div class="graph-legend">
        <span><span class="legend-dot" style="background:#1B6F63;"></span>單字</span>
        <span><span class="legend-dot" style="background:#B3541E;"></span>片語</span>
        <span><span class="legend-dot" style="background:#6D4AA8;"></span>文法</span>
        <span><span class="legend-dot" style="background:#5B7A99;"></span>課程</span>
        <span><span class="legend-dot" style="background:#B3541E; box-shadow:0 0 0 2px #B3541E;"></span>已逾期（粗邊框）</span>
      </div>`;
    const canvas = viewGraph.querySelector("#graph-canvas");
    graphView = new GraphView(canvas, { onNodeClick: handleGraphNodeClick });
    graphView.start();
  }

  // 聚焦橫幅：目前中心＋深度，加上「展開下一層／上一步／顯示全部」三個
  // 動作——逐層探索的操作全部收在這裡，不需要拖曳、也不需要另外的模式切換。
  const banner = viewGraph.querySelector("#focus-banner");
  if (focusNodeId) {
    const centerNode = nodes.find((n) => n.id === focusNodeId);
    const canExpand = focusDepth < MAX_FOCUS_DEPTH;
    banner.innerHTML = `
      <div class="graph-focus-banner">
        <span>🔍 正在探索「${escapeHtml(centerNode?.headword || "")}」（${focusDepth} 步內）</span>
        <div class="graph-focus-actions">
          ${canExpand ? `<a href="#" id="focus-expand">＋ 展開下一層</a>` : ""}
          <a href="#" id="focus-back">← 上一步</a>
          <a href="#" id="focus-reset">✕ 顯示全部</a>
        </div>
      </div>`;
    banner.querySelector("#focus-expand")?.addEventListener("click", (e) => {
      e.preventDefault();
      focusDepth = Math.min(MAX_FOCUS_DEPTH, focusDepth + 1);
      paintGraph();
    });
    banner.querySelector("#focus-back").addEventListener("click", (e) => {
      e.preventDefault();
      focusNodeId = focusHistory.length > 0 ? focusHistory.pop() : null;
      focusDepth = 1;
      paintGraph();
    });
    banner.querySelector("#focus-reset").addEventListener("click", (e) => {
      e.preventDefault();
      focusNodeId = null;
      focusHistory = [];
      focusDepth = 1;
      paintGraph();
    });
  } else {
    banner.innerHTML = "";
  }

  const { nodes: graphNodes, edges: graphEdges } = focusNodeId ? bfsSubgraph(focusNodeId, nodes, edges, focusDepth) : { nodes, edges };

  const today = new Date().toISOString().slice(0, 10);
  const reviewStates = await db.getAllReviewStates();
  const overdueIds = new Set();
  for (const n of graphNodes) {
    const rs = reviewStates.get(n.id);
    if (rs && rs.due_at <= today) overdueIds.add(n.id);
  }
  graphView.setData(graphNodes, graphEdges, { overdueIds });
}

/* ---------------- global search overlay ---------------- */

const searchBackdrop = document.getElementById("overlay-search");
const searchInput = document.getElementById("search-input");
const searchResults = document.getElementById("search-results");

function openSearch() {
  searchBackdrop.hidden = false;
  searchInput.value = "";
  searchResults.innerHTML = "";
  searchInput.focus();
}
function closeSearch() {
  searchBackdrop.hidden = true;
}
searchBackdrop.addEventListener("click", (e) => {
  if (e.target === searchBackdrop) closeSearch();
});
let searchDebounce;
searchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(async () => {
    const q = searchInput.value.trim();
    if (!q) {
      searchResults.innerHTML = "";
      return;
    }
    const results = (await db.searchNodes(q)).slice(0, 20);
    searchResults.innerHTML =
      results
        .map(
          (n) => `<div class="suggest-item" data-goto="${n.id}">
            <span class="type-badge type-${n.type}">${typeLabel(n.type)}</span>
            <span>${escapeHtml(n.headword)}</span>
            <span class="hint">${escapeHtml((n.type === "grammar" ? grammarPreviewText(n) : n.translation) || "")}</span>
          </div>`
        )
        .join("") || `<div class="suggest-empty">找不到符合的內容</div>`;
    searchResults.querySelectorAll("[data-goto]").forEach((item) => {
      item.onclick = () => {
        closeSearch();
        openDetailPanel(item.dataset.goto);
      };
    });
  }, 150);
});

document.getElementById("btn-search").onclick = openSearch;
document.getElementById("btn-add").onclick = () => openEditorModal({ mode: "create" });

/* ---------------- backup: export / import ---------------- */

document.getElementById("btn-export").onclick = async () => {
  const payload = await db.exportAllData();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `english-second-brain-backup-${db.todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast("已匯出備份檔案");
};

const importInput = document.getElementById("import-file-input");
document.getElementById("btn-import").onclick = () => importInput.click();
importInput.addEventListener("change", async () => {
  const file = importInput.files[0];
  importInput.value = "";
  if (!file) return;
  const confirmed = confirm("匯入將會覆蓋目前所有資料，確定要繼續嗎？建議先匯出一份目前的備份。");
  if (!confirmed) return;
  try {
    let payload;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error("這不是有效的備份檔案（JSON 格式錯誤），請確認選對檔案");
    }
    await db.importAllData(payload);
    toast("匯入完成，資料已還原");
    await router();
    await updateDueBadge();
  } catch (err) {
    toast("匯入失敗：" + err.message);
  }
});

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openSearch();
  }
  if (e.key === "Escape") {
    closeSearch();
    document.getElementById("overlay-editor").hidden = true;
    if (!document.getElementById("overlay-detail").hidden) {
      import("./panels.js").then((m) => m.closeDetailPanel());
    }
  }
});

/* ---------------- seed data (first run) ---------------- */

async function seedIfEmpty() {
  const existing = await db.listNodes();
  if (existing.length > 0) return;

  const abandon = await db.createNode({
    type: "word",
    headword: "abandon",
    translation: "放棄；遺棄",
    part_of_speech: "v.",
    source_note: "PRD 範例",
    supplement_note: "常見句型：abandon + N（abandon the plan／abandon ship）。不要跟 abundant（豐富的）搞混，拼字很像但意思完全不同。",
    examples: "She refused to abandon her dream.",
  });
  const giveUp = await db.createNode({ type: "phrase", headword: "give up", translation: "放棄", source_note: "PRD 範例" });
  const desert = await db.createNode({ type: "word", headword: "desert", translation: "遺棄；沙漠", part_of_speech: "v./n.", source_note: "PRD 範例" });

  await db.createEdge({ from_node_id: abandon.id, to_node_id: giveUp.id, relation_type: "synonym", note: "口語上更常用 give up" });
  await db.createEdge({ from_node_id: abandon.id, to_node_id: desert.id, relation_type: "synonym", note: "desert 較正式，也可指「遺棄某人」" });

  const course = await db.createCourse({
    date: db.todayStr(),
    title: "Unit 3 — 動詞片語",
    content:
      "## 今天學到的重點\n\n今天教了幾個表示「放棄」的說法，比較語感差異：\n\n- **abandon**：較正式，也可以指「遺棄」一個人或地方\n- **give up**：口語最常用\n- **desert**：正式，強調「拋下不管」\n\n## 我的理解\n\n這三個字選哪個，關鍵是正式程度跟有沒有「拋下他人」的語感，不是意思本身不同。\n\n之後想查：[Cambridge Dictionary](https://dictionary.cambridge.org) 上這幾個字的例句還有沒有更細的差異。",
  });
  await db.linkNodeToCourse(abandon.id, course.id);
  await db.linkNodeToCourse(giveUp.id, course.id);
}

/* ---------------- init ---------------- */

setRefreshHandler(() => {
  router();
  updateDueBadge();
  updatePendingBadge();
});

window.addEventListener("hashchange", router);

(async function init() {
  await db.migrateSentencesToExamples();
  await seedIfEmpty();
  if (!location.hash) location.hash = "#/graph";
  await router();
  await updateDueBadge();
  await updatePendingBadge();
})();

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
