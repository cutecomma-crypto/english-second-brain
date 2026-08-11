const DB_NAME = "esb";
const DB_VERSION = 4;

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = openDBRequest();
  return dbPromise;
}

function openDBRequest() {
  const opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => {
      dbPromise = null;
      reject(
        new Error(
          "資料庫升級被擋住了——通常是因為這個網站還開著別的分頁。請關閉其他分頁後重新整理這一頁再試一次。"
        )
      );
    };
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = event.oldVersion;

      if (oldVersion < 1) {
        const nodes = db.createObjectStore("nodes", { keyPath: "id" });
        nodes.createIndex("type", "type");

        const edges = db.createObjectStore("edges", { keyPath: "id" });
        edges.createIndex("from_node_id", "from_node_id");
        edges.createIndex("to_node_id", "to_node_id");

        const noteEntries = db.createObjectStore("noteEntries", { keyPath: "id" });
        noteEntries.createIndex("node_id", "node_id");

        db.createObjectStore("reviewStates", { keyPath: "node_id" });

        const reviewLogs = db.createObjectStore("reviewLogs", { keyPath: "id" });
        reviewLogs.createIndex("node_id", "node_id");
      }

      if (oldVersion < 2) {
        // v0.2: courses + the node<->course join table (see PRD Stage 02, "概念三")
        const courses = db.createObjectStore("courses", { keyPath: "id" });
        courses.createIndex("date", "date");

        const links = db.createObjectStore("nodeCourseLinks", { keyPath: "id" });
        links.createIndex("node_id", "node_id");
        links.createIndex("course_id", "course_id");

        // Drop the old four-layer notes table (PRD Stage 02.4/02.7 — replaced
        // by Node.supplement_note). No data migration: at this point the only
        // rows in it are seed/example data, nothing created by the user yet.
        if (db.objectStoreNames.contains("noteEntries")) {
          db.deleteObjectStore("noteEntries");
        }
      }

      if (oldVersion < 3) {
        // v0.3: file attachments per course (PDFs, images, audio recordings).
        // Stored as native Blob/File values — IndexedDB supports binary
        // values directly, so there's no need to inflate them to Base64
        // (that conversion only happens at the JSON export/import boundary).
        const attachments = db.createObjectStore("courseAttachments", { keyPath: "id" });
        attachments.createIndex("course_id", "course_id");
      }

      if (oldVersion < 4) {
        // v0.4 · 產品健檢 Phase 4：待處理／待理解 inbox（見 PRD 健檢 B）——
        // 目前唯一沒有對應實體的東西：「一個還沒解決的問題」。可選擇性地
        // 連到內容或課程，但不強制，兩者皆空也能單獨存在。
        const pending = db.createObjectStore("pendingQuestions", { keyPath: "id" });
        pending.createIndex("node_id", "node_id");
        pending.createIndex("course_id", "course_id");
        pending.createIndex("status", "status");
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // If another tab needs a newer version later, close gracefully instead
      // of blocking it (the flip side of the onblocked handler above).
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });

  const timeout = new Promise((_, reject) => {
    setTimeout(() => {
      dbPromise = null;
      reject(
        new Error(
          "資料庫連線逾時（超過 8 秒沒有回應）。請打開瀏覽器開發者工具的 Application／Storage 分頁，檢查 IndexedDB 裡的 esb 資料庫狀態。"
        )
      );
    }, 8000);
  });

  return Promise.race([opening, timeout]);
}

function uid() {
  return crypto.randomUUID();
}
function nowISO() {
  return new Date().toISOString();
}
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function tx(storeNames, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeNames, mode);
    const stores = Array.isArray(storeNames)
      ? Object.fromEntries(storeNames.map((n) => [n, t.objectStore(n)]))
      : t.objectStore(storeNames);
    let result;
    Promise.resolve(fn(stores))
      .then((r) => (result = r))
      .catch(reject);
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- Nodes ---------------- */

export async function listNodes() {
  return tx("nodes", "readonly", (s) => reqToPromise(s.getAll()));
}

export async function getNode(id) {
  return tx("nodes", "readonly", (s) => reqToPromise(s.get(id)));
}

// 單字常常不只一種詞性、每種詞性翻譯不同（例如 book：n. 書／v. 預訂）。
// senses 是 [{part_of_speech, translation}] 的清單，只有單字類型會用到；
// translation 欄位保留下來當「自動組合摘要」，讓列表／搜尋／複習等既有畫面
// 完全不用改，繼續讀同一個欄位就好。
export function joinSenses(senses) {
  return (senses || [])
    .map((s) => ({ part_of_speech: (s.part_of_speech || "").trim(), translation: (s.translation || "").trim() }))
    .filter((s) => s.translation)
    .map((s) => (s.part_of_speech ? `${s.part_of_speech} ${s.translation}` : s.translation))
    .join("；");
}

export function cleanSynonyms(synonyms) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of synonyms || []) {
    const s = (raw || "").trim();
    if (!s || seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    cleaned.push(s);
  }
  return cleaned.length ? cleaned : null;
}

function cleanSenses(senses) {
  return (senses || [])
    .map((s) => ({
      part_of_speech: (s.part_of_speech || "").trim(),
      translation: (s.translation || "").trim(),
      // 每個意思自己的例句，這樣針對某個詞性記例句才有意義（例如 book 的
      // n. 用 "I'm reading a book." v. 用 "I'll book a table."）。
      example: (s.example || "").trim() || null,
    }))
    .filter((s) => s.translation);
}

export async function createNode({
  type,
  headword,
  translation,
  pronunciation,
  part_of_speech,
  source_note,
  supplement_note,
  pattern,
  senses,
  grammar_category,
  phrase_type,
  examples,
  signal_words,
  caution_note,
  is_self_study,
  synonyms,
}) {
  const cleanedSenses = cleanSenses(senses);
  const node = {
    id: uid(),
    type,
    headword: headword.trim(),
    translation: cleanedSenses.length ? joinSenses(cleanedSenses) : (translation || "").trim(),
    pronunciation: pronunciation?.trim() || null,
    part_of_speech: part_of_speech?.trim() || null,
    // 只有單字類型使用；其他類型維持 null。純新增欄位，不需要 schema migration。
    senses: cleanedSenses.length ? cleanedSenses : null,
    // synonyms：同義字標籤清單，只有單字類型使用。純字串陣列，去除空白／
    // 重複；其他類型維持 null。
    synonyms: type === "word" ? cleanSynonyms(synonyms) : null,
    // is_self_study：這個字是不是從「自主單字」來源加入的（例如手機單字
    // App）。跟課程來源（nodeCourseLinks）不衝突，一個字可以同時有兩種
    // 來源。只有單字類型會用到，其他類型維持 null。
    is_self_study: type === "word" ? !!is_self_study : null,
    // pattern：文法的「核心公式」欄位（例如 S + have/has + p.p.），只有
    // 文法類型使用；其他類型維持 null。
    pattern: pattern?.trim() || null,
    // 文法內容專用欄位——其他類型不使用，維持 null。全部是純新增欄位，
    // IndexedDB 不需要 schema migration 就能存放。
    // grammar_category：時態／句型／介系詞·詞性／子句·連詞／其他，純分類標籤，不影響欄位結構
    grammar_category: grammar_category || null,
    // phrase_type：片語專屬的詞性（名詞/動詞/形容詞/副詞/介系詞片語……）
    phrase_type: phrase_type || null,
    // examples：例句，跟核心說明分開記錄，方便分別閱讀
    examples: examples?.trim() || null,
    // signal_words：常見搭配／關鍵字（例如 already, yet, since）
    signal_words: signal_words?.trim() || null,
    // caution_note：易錯提醒
    caution_note: caution_note?.trim() || null,
    supplement_note: supplement_note?.trim() || null,
    source_note: source_note?.trim() || null,
    created_at: nowISO(),
    updated_at: nowISO(),
  };
  await tx("nodes", "readwrite", (s) => reqToPromise(s.add(node)));
  await upsertReviewState(node.id, {});
  return node;
}

export async function updateNode(id, patch) {
  return tx("nodes", "readwrite", async (s) => {
    const existing = await reqToPromise(s.get(id));
    if (!existing) return null;
    const updated = { ...existing, ...patch, updated_at: nowISO() };
    await reqToPromise(s.put(updated));
    return updated;
  });
}

export async function deleteNode(id) {
  const edges = await getEdgesForNode(id);
  await tx("edges", "readwrite", async (s) => {
    for (const e of edges) await reqToPromise(s.delete(e.id));
  });
  const links = await getCourseLinksForNode(id);
  await tx("nodeCourseLinks", "readwrite", async (s) => {
    for (const l of links) await reqToPromise(s.delete(l.id));
  });
  await tx("reviewStates", "readwrite", (s) => reqToPromise(s.delete(id)));
  const logs = await tx("reviewLogs", "readonly", (s) =>
    reqToPromise(s.index("node_id").getAll(id))
  );
  await tx("reviewLogs", "readwrite", async (s) => {
    for (const l of logs) await reqToPromise(s.delete(l.id));
  });
  // 待處理項目本身仍有價值，內容被刪除時只解除連結，不連帶刪除問題。
  const linkedQuestions = await getPendingQuestionsForNode(id);
  await tx("pendingQuestions", "readwrite", async (s) => {
    for (const q of linkedQuestions) await reqToPromise(s.put({ ...q, node_id: null }));
  });
  await tx("nodes", "readwrite", (s) => reqToPromise(s.delete(id)));
}

export async function searchNodes(query) {
  const all = await listNodes();
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter(
    (n) =>
      n.headword.toLowerCase().includes(q) ||
      (n.translation || "").toLowerCase().includes(q) ||
      (n.pattern || "").toLowerCase().includes(q)
  );
}

// 避免重複建立同一個單字（例如手機 App 的自主單字之後又在家教課教到）。
// 刻意只做完全比對（不分大小寫、去頭尾空白），不做模糊或語意猜測——
// 判斷不了的情況寧可不比對，交給使用者自己決定。
export async function findWordByHeadword(headword) {
  const target = (headword || "").trim().toLowerCase();
  if (!target) return null;
  const words = (await listNodes()).filter((n) => n.type === "word");
  return words.find((n) => n.headword.trim().toLowerCase() === target) || null;
}

// 一次性遷移：句子曾經是獨立的 Node，靠 example_of 關聯連到單字/片語，
// 現在改成單字/片語自己的「例句」欄位。把每個句子節點的文字搬進它連到的
// 內容，再刪除句子節點（連帶清掉關聯）。已經跑過一次之後，資料庫裡不會
// 再有句子節點，之後每次呼叫都是不做事的 no-op，可以放心留在 init 流程裡。
export async function migrateSentencesToExamples() {
  const sentences = (await listNodes()).filter((n) => n.type === "sentence");
  if (sentences.length === 0) return;
  for (const sentence of sentences) {
    const edges = await getEdgesForNode(sentence.id);
    const targetIds = edges
      .filter((e) => e.relation_type === "example_of" && e.from_node_id === sentence.id)
      .map((e) => e.to_node_id);
    for (const targetId of targetIds) {
      const target = await getNode(targetId);
      if (!target) continue;
      const merged = [target.examples, sentence.headword].filter(Boolean).join("\n");
      await updateNode(targetId, { examples: merged });
    }
    await deleteNode(sentence.id);
  }
}

/* ---------------- Edges ---------------- */

export async function createEdge({ from_node_id, to_node_id, relation_type, note }) {
  if (from_node_id === to_node_id) throw new Error("內容不能與自己建立關聯");
  const existing = await getEdgesForNode(from_node_id);
  const dup = existing.find(
    (e) =>
      e.relation_type === relation_type &&
      ((e.from_node_id === from_node_id && e.to_node_id === to_node_id) ||
        (e.from_node_id === to_node_id && e.to_node_id === from_node_id))
  );
  if (dup) return dup;
  const edge = {
    id: uid(),
    from_node_id,
    to_node_id,
    relation_type,
    note: note?.trim() || null,
    created_at: nowISO(),
  };
  await tx("edges", "readwrite", (s) => reqToPromise(s.add(edge)));
  return edge;
}

export async function deleteEdge(id) {
  return tx("edges", "readwrite", (s) => reqToPromise(s.delete(id)));
}

export async function listEdges() {
  return tx("edges", "readonly", (s) => reqToPromise(s.getAll()));
}

export async function getEdgesForNode(nodeId) {
  return tx("edges", "readonly", async (s) => {
    const [a, b] = await Promise.all([
      reqToPromise(s.index("from_node_id").getAll(nodeId)),
      reqToPromise(s.index("to_node_id").getAll(nodeId)),
    ]);
    const map = new Map();
    for (const e of [...a, ...b]) map.set(e.id, e);
    return [...map.values()];
  });
}

/* ---------------- Review state / SM-2 bookkeeping ---------------- */

export async function getReviewState(nodeId) {
  return tx("reviewStates", "readonly", (s) => reqToPromise(s.get(nodeId)));
}

// 一次撈出全部複習狀態、在記憶體裡建 Map，取代「每個節點各自查一次」的
// 寫法（例如圖譜頁原本是逐一 await getReviewState()，單字量一大就會變成
// 大量依序資料庫查詢，畫面明顯卡頓）。用法：getAllReviewStates().get(nodeId)。
export async function getAllReviewStates() {
  const states = await tx("reviewStates", "readonly", (s) => reqToPromise(s.getAll()));
  const map = new Map();
  for (const s of states) map.set(s.node_id, s);
  return map;
}

export async function upsertReviewState(nodeId, patch) {
  return tx("reviewStates", "readwrite", async (s) => {
    const existing = (await reqToPromise(s.get(nodeId))) || {
      node_id: nodeId,
      ease_factor: 2.5,
      interval_days: 0,
      repetitions: 0,
      due_at: todayStr(),
      last_reviewed_at: null,
      lapse_count: 0,
    };
    const updated = { ...existing, ...patch };
    await reqToPromise(s.put(updated));
    return updated;
  });
}

export async function addReviewLog({ node_id, rating, interval_before, interval_after }) {
  const log = {
    id: uid(),
    node_id,
    reviewed_at: nowISO(),
    rating,
    interval_before,
    interval_after,
  };
  await tx("reviewLogs", "readwrite", (s) => reqToPromise(s.add(log)));
  return log;
}

/* ---------------- Courses (v0.2) ---------------- */

export async function listCourses() {
  const all = await tx("courses", "readonly", (s) => reqToPromise(s.getAll()));
  return all.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

export async function getCourse(id) {
  return tx("courses", "readonly", (s) => reqToPromise(s.get(id)));
}

export async function createCourse({ date, title, content, teacher, keywords }) {
  const course = {
    id: uid(),
    date: date || todayStr(),
    title: (title || "").trim(),
    teacher: teacher?.trim() || null,
    content: content?.trim() || null,
    // keywords：方便日後快速查詢這堂課的關鍵字，自由文字（用逗號或空白分隔皆可）。
    keywords: keywords?.trim() || null,
    created_at: nowISO(),
  };
  await tx("courses", "readwrite", (s) => reqToPromise(s.add(course)));
  return course;
}

export async function updateCourse(id, patch) {
  return tx("courses", "readwrite", async (s) => {
    const existing = await reqToPromise(s.get(id));
    if (!existing) return null;
    const updated = { ...existing, ...patch };
    await reqToPromise(s.put(updated));
    return updated;
  });
}

export async function deleteCourse(id) {
  const links = await getCourseLinksForCourse(id);
  await tx("nodeCourseLinks", "readwrite", async (s) => {
    for (const l of links) await reqToPromise(s.delete(l.id));
  });
  const attachments = await getAttachmentsForCourse(id);
  await tx("courseAttachments", "readwrite", async (s) => {
    for (const a of attachments) await reqToPromise(s.delete(a.id));
  });
  const linkedQuestions = await getPendingQuestionsForCourse(id);
  await tx("pendingQuestions", "readwrite", async (s) => {
    for (const q of linkedQuestions) await reqToPromise(s.put({ ...q, course_id: null }));
  });
  await tx("courses", "readwrite", (s) => reqToPromise(s.delete(id)));
}

/* ---------------- Node <-> Course links (v0.2) ---------------- */

export async function linkNodeToCourse(nodeId, courseId) {
  const existing = await getCourseLinksForNode(nodeId);
  const dup = existing.find((l) => l.course_id === courseId);
  if (dup) return dup;
  const link = { id: uid(), node_id: nodeId, course_id: courseId, created_at: nowISO() };
  await tx("nodeCourseLinks", "readwrite", (s) => reqToPromise(s.add(link)));
  return link;
}

export async function unlinkNodeFromCourse(linkId) {
  return tx("nodeCourseLinks", "readwrite", (s) => reqToPromise(s.delete(linkId)));
}

export async function getCourseLinksForNode(nodeId) {
  return tx("nodeCourseLinks", "readonly", (s) => reqToPromise(s.index("node_id").getAll(nodeId)));
}

export async function getCourseLinksForCourse(courseId) {
  return tx("nodeCourseLinks", "readonly", (s) => reqToPromise(s.index("course_id").getAll(courseId)));
}

export async function getCoursesForNode(nodeId) {
  const links = await getCourseLinksForNode(nodeId);
  const courses = await Promise.all(links.map((l) => getCourse(l.course_id)));
  return courses.filter(Boolean).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
}

// 產品健檢 Phase 1：課程複習需要「這堂課有哪些單字」——之前拿掉是因為
// 沒人用，這次「複習本課單字」（Phase 2）會用到，加回來。
export async function getNodesForCourse(courseId) {
  const links = await getCourseLinksForCourse(courseId);
  const nodes = await Promise.all(links.map((l) => getNode(l.node_id)));
  return nodes.filter(Boolean);
}

/* ---------------- Course attachments (v0.3) ---------------- */

export async function addAttachment(courseId, file) {
  const record = {
    id: uid(),
    course_id: courseId,
    filename: file.name,
    mime_type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
    created_at: nowISO(),
  };
  await tx("courseAttachments", "readwrite", (s) => reqToPromise(s.add(record)));
  return record;
}

export async function getAttachmentsForCourse(courseId) {
  const all = await tx("courseAttachments", "readonly", (s) => reqToPromise(s.index("course_id").getAll(courseId)));
  return all.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export async function deleteAttachment(id) {
  return tx("courseAttachments", "readwrite", (s) => reqToPromise(s.delete(id)));
}

/* ---------------- Pending questions (v0.4) ---------------- */

export async function createPendingQuestion({ content, node_id = null, course_id = null }) {
  const question = {
    id: uid(),
    content: (content || "").trim(),
    node_id: node_id || null,
    course_id: course_id || null,
    status: "open",
    resolution_note: null,
    created_at: nowISO(),
    resolved_at: null,
  };
  await tx("pendingQuestions", "readwrite", (s) => reqToPromise(s.add(question)));
  return question;
}

export async function listPendingQuestions() {
  const all = await tx("pendingQuestions", "readonly", (s) => reqToPromise(s.getAll()));
  return all.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getPendingQuestion(id) {
  return tx("pendingQuestions", "readonly", (s) => reqToPromise(s.get(id)));
}

export async function getPendingQuestionsForNode(nodeId) {
  return tx("pendingQuestions", "readonly", (s) => reqToPromise(s.index("node_id").getAll(nodeId)));
}

export async function getPendingQuestionsForCourse(courseId) {
  return tx("pendingQuestions", "readonly", (s) => reqToPromise(s.index("course_id").getAll(courseId)));
}

export async function resolvePendingQuestion(id, resolution_note) {
  return tx("pendingQuestions", "readwrite", async (s) => {
    const existing = await reqToPromise(s.get(id));
    if (!existing) return null;
    const updated = { ...existing, status: "resolved", resolution_note: resolution_note?.trim() || null, resolved_at: nowISO() };
    await reqToPromise(s.put(updated));
    return updated;
  });
}

export async function reopenPendingQuestion(id) {
  return tx("pendingQuestions", "readwrite", async (s) => {
    const existing = await reqToPromise(s.get(id));
    if (!existing) return null;
    const updated = { ...existing, status: "open", resolution_note: null, resolved_at: null };
    await reqToPromise(s.put(updated));
    return updated;
  });
}

export async function deletePendingQuestion(id) {
  return tx("pendingQuestions", "readwrite", (s) => reqToPromise(s.delete(id)));
}

/* ---------------- Aggregate helpers ---------------- */

// 課程本身不是 Node，但 nodeCourseLinks 這張表已經明確記錄「這堂課用過
// 哪些內容」——這是資料裡本來就存在的確認關係，只是圖譜之前沒有讀它。
// 這裡把課程／連結「運算成」圖譜看得懂的節點／關聯格式，純粹是顯示用的
// 組合，不寫回任何資料表，courses／nodeCourseLinks 本身完全不受影響，
// 匯入匯出、課程頁、複習頁都不會被這個改動影響到。
export async function getGraphData() {
  const [nodes, edges, courses, courseLinks] = await Promise.all([
    listNodes(),
    listEdges(),
    listCourses(),
    tx("nodeCourseLinks", "readonly", (s) => reqToPromise(s.getAll())),
  ]);

  const courseNodes = courses.map((c) => ({
    id: c.id,
    type: "course",
    headword: c.title?.trim() || c.date || "未命名課程",
  }));
  const courseEdges = courseLinks.map((l) => ({
    id: `course-link-${l.id}`,
    from_node_id: l.course_id,
    to_node_id: l.node_id,
    relation_type: "course_link",
  }));

  return {
    nodes: [...nodes, ...courseNodes],
    edges: [...edges, ...courseEdges],
  };
}

export async function getEdgeCounts() {
  const edges = await listEdges();
  const counts = new Map();
  for (const e of edges) {
    counts.set(e.from_node_id, (counts.get(e.from_node_id) || 0) + 1);
    counts.set(e.to_node_id, (counts.get(e.to_node_id) || 0) + 1);
  }
  return counts;
}

/* ---------------- Export / Import (backup) ---------------- */

const STORE_NAMES = ["nodes", "edges", "reviewStates", "reviewLogs", "courses", "nodeCourseLinks", "courseAttachments", "pendingQuestions"];

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function exportAllData() {
  const data = {};
  for (const name of STORE_NAMES) {
    const records = await tx(name, "readonly", (s) => reqToPromise(s.getAll()));
    if (name === "courseAttachments") {
      // Blobs aren't JSON-serializable — encode as data URLs just for the backup file.
      data[name] = await Promise.all(
        records.map(async ({ blob, ...rest }) => ({ ...rest, data_url: await blobToDataUrl(blob) }))
      );
    } else {
      data[name] = records;
    }
  }
  return {
    app: "english-second-brain",
    schema_version: DB_VERSION,
    exported_at: nowISO(),
    data,
  };
}

export async function importAllData(payload) {
  const data = payload?.data;
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.edges)) {
    throw new Error("備份檔案格式不正確");
  }

  // Decode attachment data URLs back into Blobs *before* opening the write
  // transaction — fetch()/FileReader aren't IndexedDB requests, so awaiting
  // them inside the tx callback could let the transaction auto-commit early.
  let preparedAttachments;
  try {
    preparedAttachments = await Promise.all(
      (data.courseAttachments || []).map(async (record) => {
        if (!record.data_url) return record;
        const { data_url, ...rest } = record;
        return { ...rest, blob: await dataUrlToBlob(data_url) };
      })
    );
  } catch {
    // data_url 損毀／格式不對時 fetch() 會丟出瀏覽器原生的錯誤（例如
    // "Failed to fetch"），使用者看了不會懂，這裡換成看得懂的中文說明。
    throw new Error("備份檔案中的附件資料已損毀，無法還原（可能是檔案被截斷或修改過）");
  }

  try {
    await tx(STORE_NAMES, "readwrite", async (stores) => {
      for (const name of STORE_NAMES) {
        await reqToPromise(stores[name].clear());
        const records = name === "courseAttachments" ? preparedAttachments : data[name] || [];
        for (const record of records) {
          await reqToPromise(stores[name].put(record));
        }
      }
    });
  } catch {
    throw new Error("備份檔案內容格式不正確，無法寫入資料庫");
  }
}

export { uid, nowISO, todayStr };
