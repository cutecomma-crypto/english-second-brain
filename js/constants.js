// 句子曾經是獨立類型，現在改成單字/片語自己的「例句」欄位（見 db.js
// migrateSentencesToExamples），不再是可以新增的類型。
export const NODE_TYPES = [
  { value: "word", label: "單字" },
  { value: "phrase", label: "片語" },
  { value: "grammar", label: "文法" },
];

export const RELATION_TYPES = [
  { value: "synonym", label: "synonym 同義" },
  { value: "antonym", label: "antonym 反義" },
  { value: "collocation", label: "collocation 搭配詞" },
  { value: "example_of", label: "example_of 例句對應" },
  { value: "derivative", label: "derivative 詞形變化" },
  { value: "contrast", label: "contrast 易混淆對比" },
  { value: "root_share", label: "root_share 字根共享" },
  { value: "topic_related", label: "topic_related 情境相關" },
  { value: "custom", label: "custom 自訂" },
];

// 「不知道」跟「忘記了」在畫面上是兩個不同按鈕（讓使用者誠實記錄自己到底
// 是完全沒印象、還是有印象但答錯），但兩者對複習排程演算法來說效果一樣——
// 都算沒通過，重新排進近期複習佇列（見 sm2.js 的 nextReviewState）。
export const RATINGS = [
  { value: "unknown", label: "不知道", hint: "完全沒印象", cls: "rating-unknown" },
  { value: "again", label: "忘記了", hint: "有印象但答錯", cls: "rating-again" },
  { value: "hard", label: "想很久", hint: "想了一下才想起", cls: "rating-hard" },
  { value: "easy", label: "很容易", hint: "秒答、很熟悉", cls: "rating-easy" },
];

export function typeLabel(v) {
  return NODE_TYPES.find((t) => t.value === v)?.label ?? v;
}
export function relationLabel(v) {
  return RELATION_TYPES.find((t) => t.value === v)?.label ?? v;
}

// 文法內容的分類標籤——純粹用來篩選／瀏覽，不會改變下方表單欄位結構
// （欄位對所有文法內容都一樣：標題＋分類＋核心說明與例句＋常見搭配／關鍵字
// ＋易錯提醒）。
export const GRAMMAR_CATEGORIES = [
  { value: "tense", label: "時態" },
  { value: "sentence_pattern", label: "句型" },
  { value: "clause_conjunction", label: "子句/連詞" },
  { value: "preposition_pos", label: "介系詞" },
  { value: "verb_form", label: "動詞變化" },
  { value: "other", label: "其他" },
];

export function grammarCategoryLabel(v) {
  return GRAMMAR_CATEGORIES.find((c) => c.value === v)?.label ?? v;
}

// 列表／搜尋建議框／複習字卡的一行預覽用——顯示分類標籤；沒有分類標籤時
// 退回顯示健檢前舊資料可能留下的「句型結構」欄位，維持向下相容。
export function grammarPreviewText(node) {
  if (node.grammar_category) return grammarCategoryLabel(node.grammar_category);
  return node.pattern || "";
}

// 片語的詞性——片語本身就是一個詞性單位（例如 "give up" 整體是動詞片語），
// 所以是單選，不像單字的詞性是每個意思各自一個。
export const PHRASE_TYPES = [
  { value: "noun_phrase", label: "名詞片語" },
  { value: "verb_phrase", label: "動詞片語" },
  { value: "adjective_phrase", label: "形容詞片語" },
  { value: "adverb_phrase", label: "副詞片語" },
  { value: "preposition_phrase", label: "介系詞片語" },
  { value: "other", label: "其他" },
];

export function phraseTypeLabel(v) {
  return PHRASE_TYPES.find((t) => t.value === v)?.label ?? v;
}

// 單字的詞性——每個意思（sense）各自選一個，存的還是縮寫（n./v./adj.…），
// 跟現有的顯示邏輯（詞性與翻譯清單、詳情頁）完全相容，不用改資料格式。
export const WORD_POS = [
  { value: "n.", label: "n. 名詞" },
  { value: "v.", label: "v. 動詞" },
  { value: "adj.", label: "adj. 形容詞" },
  { value: "adv.", label: "adv. 副詞" },
  { value: "prep.", label: "prep. 介系詞" },
  { value: "pron.", label: "pron. 代名詞" },
  { value: "conj.", label: "conj. 連接詞" },
  { value: "int.", label: "int. 感嘆詞" },
];

// 列表頁、課程頁的單字列表共用——把「詞性」跟「翻譯」拆開取，才能各自放進
// 固定寬度的欄位，不會像合併字串那樣長度一變欄位就跑掉。
export function wordRowMeta(node) {
  if (node.type === "grammar") return { pos: "", translation: grammarPreviewText(node) };
  if (node.type === "phrase") return { pos: node.phrase_type ? phraseTypeLabel(node.phrase_type) : "", translation: node.translation || "" };
  if (node.senses?.length) {
    return {
      pos: node.senses[0].part_of_speech || "",
      translation: node.senses.map((s) => s.translation).filter(Boolean).join("；"),
    };
  }
  return { pos: node.part_of_speech || "", translation: node.translation || "" };
}
