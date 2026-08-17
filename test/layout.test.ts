import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const projectFile = (relativePath: string) => readFileSync(fileURLToPath(new URL(`../${relativePath}`, import.meta.url)), 'utf8');

const css = projectFile('web/styles.css');
const app = projectFile('frontend/src/App.tsx');
const layout = projectFile('frontend/src/components/Layout.tsx');
const frontendMarkup = [
  app,
  layout,
  projectFile('frontend/src/components/ConfigDialog.tsx'),
  projectFile('frontend/src/components/Primitives.tsx'),
  projectFile('frontend/src/main.tsx')
].join('\n');
const frontendCss = projectFile('frontend/src/styles.css');

const terminalMarker = '/* ===== Fixed-height terminal workspace ===== */';
const terminalStart = css.indexOf(terminalMarker);
assert.notEqual(terminalStart, -1, 'terminal workspace overrides are missing');

const terminalCss = css.slice(terminalStart);
const desktopMediaStart = terminalCss.indexOf('@media (max-width: 1120px)');
assert.notEqual(desktopMediaStart, -1, 'desktop terminal breakpoint is missing');
const desktopCss = terminalCss.slice(0, desktopMediaStart);

const mobileMediaStart = terminalCss.indexOf('@media (max-width: 820px)');
assert.notEqual(mobileMediaStart, -1, 'mobile terminal breakpoint is missing');
const mobileCss = terminalCss.slice(mobileMediaStart);

test('桌面工作台使用 52px 图标栏并锁定在单个视口内', () => {
  assert.match(desktopCss, /html, body, #root\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(desktopCss, /\.app-shell\s*\{[^}]*height:\s*100dvh[^}]*grid-template-columns:\s*52px\s+minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s);
  assert.match(desktopCss, /\.sidebar\s*\{[^}]*height:\s*100dvh[^}]*align-items:\s*center/s);
  assert.match(desktopCss, /\.workspace\s*\{[^}]*height:\s*100dvh[^}]*min-height:\s*0/s);
  assert.match(desktopCss, /\.view-root\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
  assert.match(desktopCss, /\.page\s*\{[^}]*height:\s*100%[^}]*min-height:\s*0[^}]*overflow:\s*hidden/s);
});

test('列表、表格和面板拥有自己的滚动区域', () => {
  assert.match(desktopCss, /\.content-grid\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1/s);
  assert.match(desktopCss, /\.panel\s*\{[^}]*min-height:\s*0[^}]*flex-direction:\s*column/s);
  assert.match(desktopCss, /\.panel-body\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(desktopCss, /\.table-wrap\s*\{[^}]*min-height:\s*0[^}]*flex:\s*1[^}]*overflow:\s*auto[^}]*overscroll-behavior:\s*contain[^}]*scrollbar-gutter:\s*stable/s);
  assert.match(desktopCss, /\.overview-workspace\s*\{[^}]*min-height:\s*0[^}]*grid-template-areas:/s);
  assert.match(desktopCss, /\.factors-page \.content-grid\s*\{[^}]*grid-template-areas:/s);
  assert.match(desktopCss, /\.backtest-page \.content-grid\s*\{[^}]*grid-template-areas:/s);
  assert.match(desktopCss, /\.paper-page \.content-grid\s*\{[^}]*grid-template-areas:/s);
});

test('窄屏只恢复工作区滚动，桌面终端规则不会退化成 body 滚动', () => {
  assert.match(mobileCss, /body\s*\{[^}]*overflow:\s*hidden/s);
  assert.match(mobileCss, /\.view-root\s*\{[^}]*overflow:\s*auto/s);
  assert.match(mobileCss, /\.page\s*\{[^}]*height:\s*auto[^}]*overflow:\s*visible/s);
});

test('React 工作台使用图标导航和六个终端视图，不再渲染 landing hero', () => {
  assert.match(frontendCss, /@import\s+["']\.\.\/\.\.\/web\/styles\.css["']/);
  assert.match(layout, /function NavGlyph/);
  assert.match(layout, /className="nav-icon"/);
  assert.match(layout, /className="view-root" data-view=\{view\}/);
  assert.match(desktopCss, /\.nav-label\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(app, /className="hero-(?:grid|card)"/);
  for (const pageClass of ['overview-page', 'factors-page', 'research-page', 'backtest-page', 'paper-page', 'data-page']) {
    assert.match(app, new RegExp(`className="page ${pageClass}"`));
  }
});

test('六个视图共用唯一顶栏，页面内不再重复标题或渲染横向统计卡片', () => {
  assert.equal(frontendMarkup.match(/<header\b/g)?.length, 1);
  assert.match(layout, /className="topbar-actions"/);
  assert.match(app, /actions=\{headerActions\}/);
  assert.doesNotMatch(app, /<header\b/);
  assert.doesNotMatch(app, /className="page-head"/);
  assert.doesNotMatch(frontendMarkup, /className="metric-(?:grid|card)"/);
  assert.doesNotMatch(app, /<MetricCard\b/);
  assert.doesNotMatch(css, /\.metric-(?:grid|card)\b/);
});
