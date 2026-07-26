import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const settingsSource = readFileSync('src/timeline/pages/settings/settings.js', 'utf8');
const settingsHtml = readFileSync('src/timeline/pages/settings/settings.html', 'utf8');
const i18nSource = readFileSync('src/timeline/shared/i18n.js', 'utf8');
const helperStart = settingsSource.indexOf('const ACTIVE_LEARNING_PAGE_SIZES =');
const helperEnd = settingsSource.indexOf('function getActiveLearningListControls(', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'active learning pagination helpers must be present');

const context = {};
vm.createContext(context);
vm.runInContext(`${settingsSource.slice(helperStart, helperEnd)}; this.pagination = {
  ACTIVE_LEARNING_PAGE_SIZES,
  createActiveLearningListState,
  paginateActiveLearningItems,
};`, context);

const {
  ACTIVE_LEARNING_PAGE_SIZES,
  createActiveLearningListState,
  paginateActiveLearningItems,
} = context.pagination;

assert.deepEqual(Array.from(ACTIVE_LEARNING_PAGE_SIZES), [10, 20, 50, 100]);
const records = Array.from({ length: 23 }, (_, index) => ({
  id: index + 1,
  title: `Rule ${String(index + 1).padStart(2, '0')}`,
  target: index % 2 === 0 ? 'Development' : 'Design',
}));
const searchText = item => `${item.title} ${item.target}`;
const state = createActiveLearningListState();

let page = paginateActiveLearningItems(records, state, searchText);
assert.equal(page.items.length, 10);
assert.deepEqual(Array.from(page.items, item => item.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.deepEqual({ page: page.page, pageCount: page.pageCount, start: page.start, end: page.end }, {
  page: 1, pageCount: 3, start: 1, end: 10,
});

state.page = 3;
page = paginateActiveLearningItems(records, state, searchText);
assert.deepEqual(Array.from(page.items, item => item.id), [21, 22, 23]);
assert.deepEqual({ start: page.start, end: page.end }, { start: 21, end: 23 });

for (const pageSize of [10, 20, 50, 100]) {
  state.query = '';
  state.page = 1;
  state.pageSize = pageSize;
  page = paginateActiveLearningItems(records, state, searchText);
  assert.equal(page.items.length, Math.min(pageSize, records.length));
  assert.equal(page.pageSize, pageSize);
}

state.query = 'rUlE 17';
state.page = 99;
state.pageSize = 10;
page = paginateActiveLearningItems(records, state, searchText);
assert.deepEqual(Array.from(page.items, item => item.id), [17], 'search must be case-insensitive across displayed fields');
assert.equal(page.page, 1, 'filtered results must clamp an out-of-range page');

state.query = 'missing';
page = paginateActiveLearningItems(records, state, searchText);
assert.equal(page.items.length, 0);
assert.deepEqual({ page: page.page, pageCount: page.pageCount, start: page.start, end: page.end }, {
  page: 1, pageCount: 1, start: 0, end: 0,
});

state.query = '';
state.pageSize = 7;
page = paginateActiveLearningItems(records, state, searchText);
assert.equal(page.pageSize, 10, 'unsupported persisted page sizes must fall back to 10');

for (const id of ['learningFeedbackControls', 'recommendationRulesControls', 'pendingReviewsControls', 'reevaluationControls']) {
  assert.match(settingsHtml, new RegExp(`id=["']${id}["']`), `${id} must have a dedicated control host`);
}
for (const name of ['learningFeedback', 'recommendationRules', 'pendingReviews', 'reevaluation']) {
  assert.match(
    settingsSource,
    new RegExp(`updateActiveLearningListControls\\(["']${name}["']`),
    `${name} must update its own search and pagination controls`,
  );
}
for (const key of ['searchLearningRecords', 'searchRecommendationRules', 'searchPendingReviews', 'searchReevaluationResults']) {
  assert.equal((i18nSource.match(new RegExp(`${key}:`, 'g')) || []).length, 2, `${key} must be localized in English and Chinese`);
}

console.log('active learning list control tests passed');
