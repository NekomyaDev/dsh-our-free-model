import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { buildModelVisibility, hiddenIdsFor, isModelHiddenByAllowlist, isModelHiddenByLane } from '../src/store.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'
import { visibilityCopy } from '../packages/standalone/frontend/visibility-data.mjs'
import { t as translate, numLocale, providerText } from '../packages/standalone/frontend/i18n.mjs'

const require = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { transformSync } = require('esbuild')
const source = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const body = source.slice(source.indexOf('const availabilityNames')).replace('export function Models', 'function Models')
let cursor = 0
const cells = []
const react = {
  Fragment: 'fragment',
  createElement(type, props, ...children) {
    const value = { ...(props ?? {}), children }
    return { type, props: value, children }
  },
  useState(initial) {
    const index = cursor++
    if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
    return [cells[index], next => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
  },
  useRef(value) { const index = cursor++; return cells[index] ??= { current: value } },
  useEffect() {},
  useMemo(callback) { return callback() },
  useCallback(callback) { return callback },
}
const component = name => props => react.createElement(name, props)
let writes = []
let summary
const recalculate = settings => {
  const policy = settings.visibilityPolicy
  const visibility = buildModelVisibility(settings)
  const hidden = new Set(settings.hiddenModelIds ?? [])
  for (const model of summary.catalog) {
    model.hiddenByUser = hidden.has(model.id)
    model.hiddenIds = hiddenIdsFor(model, visibility)
    model.visibleIds = policy.mode === 'allowlist' && policy.visibleIds.includes(model.id) ? [model.id] : []
    model.hiddenByGroup = settings.hideFreeModels === true && model.visibilityLane === 'free'
    model.hiddenByLane = isModelHiddenByLane(model, visibility)
    model.hiddenByAllowlist = isModelHiddenByAllowlist(model, visibility)
  }
}
summary = {
  settings: {
    enabled: true, exposeRegionModels: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false,
    visibilityPolicy: { mode: 'blocklist', hiddenLanes: [], visibleIds: [] },
  },
  catalog: [
    { id: 'free', name: 'Free', channel: 'anonymous', visibilityLane: 'free', routable: true, availability: 'available' },
    { id: 'kilo', name: 'Kilo', channel: 'kilo', visibilityLane: 'kilo', routable: true, availability: 'available' },
    { id: 'combo:kilo', name: 'Kilo combo', channel: 'combo', visibilityLane: 'combo', routable: true, availability: 'available' },
    { id: 'account', name: 'Account', channel: 'lobsterai', visibilityLane: 'account', routable: true, availability: 'available' },
  ],
}
recalculate(summary.settings)
const Button = component('button')
const host = {
  async saveSettings(patch) {
    writes.push(structuredClone(patch))
    Object.assign(summary.settings, patch)
    recalculate(summary.settings)
    return summary.settings
  },
  async refresh() {},
  error(error) { throw error },
}
const context = {
  ...react,
  h: react.createElement,
  Fragment: react.Fragment,
  providers: [],
  filterModels,
  visibilityCopy,
  t: translate,
  numLocale,
  providerText,
  document: { documentElement: { lang: 'en' } },
  window: { confirm: () => true },
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }) => ({
    getTotalSize: () => count * 112,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 112 })),
    measureElement() {},
  }),
  Badge: component('badge'),
  Button,
  Input: component('input'),
  Boxes: 'boxes', Check: 'check', CircleAlert: 'alert', CircleCheck: 'check-circle', Copy: 'copy',
  Eye: 'eye', EyeOff: 'eye-off', LoaderCircle: 'loader', Play: 'play', RefreshCw: 'refresh',
  Search: 'search', SlidersHorizontal: 'sliders', Square: 'square', X: 'close',
}
vm.createContext(context)
vm.runInContext(transformSync(body + '\nglobalThis.Page = Models', {
  loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment',
}).code, context)
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
const render = () => { cursor = 0; return context.Page({ summary, host, active: true }) }
const byTitle = (tree, title) => nodes(tree).find(node => node.props.title === title && typeof node.props.onClick === 'function')
const byAria = (tree, label) => nodes(tree).find(node => node.props['aria-label'] === label && typeof node.props.onClick === 'function')
const settle = () => new Promise(resolve => setImmediate(resolve))

let tree = render()
summary.settings.hideFreeModels = true
recalculate(summary.settings)
tree = render()
byTitle(tree, 'Hide Free anonymous').props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'blocklist', hiddenLanes: ['free'], visibleIds: [] },
  hideFreeModels: false,
}, 'bulk hide migrates the legacy free group rule without keeping a broader hidden rule')
summary.settings.hideFreeModels = false
summary.settings.visibilityPolicy = { mode: 'blocklist', hiddenLanes: [], visibleIds: [] }
recalculate(summary.settings)
tree = render()
byTitle(tree, 'Hide Kilo').props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'blocklist', hiddenLanes: ['kilo'], visibleIds: [] },
})

tree = render()
byTitle(tree, 'Only Kilo').props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'allowlist', hiddenLanes: [], visibleIds: ['kilo'] },
}, 'only-lane removes the selected lane from the stronger hidden-lane rule')

summary.settings.visibilityPolicy = { mode: 'blocklist', hiddenLanes: ['kilo'], visibleIds: [] }
recalculate(summary.settings)
tree = render()
byTitle(tree, 'Only Combos').props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'allowlist', hiddenLanes: ['kilo'], visibleIds: ['combo:kilo'] },
}, 'only-lane keeps combo independent from its member lane')

tree = render()
byAria(tree, `${visibilityCopy('en').show}：account`).props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'allowlist', hiddenLanes: ['kilo'], visibleIds: ['combo:kilo', 'account'] },
}, 'allowlist eye action adds only the exact account row')

summary.settings.visibilityPolicy = { mode: 'allowlist', hiddenLanes: [], visibleIds: ['free'] }
summary.settings.hiddenModelIds = ['free']
recalculate(summary.settings)
tree = render()
assert.equal(byTitle(tree, visibilityCopy('en').selectedBlocked).props.title, visibilityCopy('en').selectedBlocked,
  'a selected exact-id row remains visibly blocked by the stronger hidden rule')

summary.settings.hideFreeModels = true
summary.settings.hideEacModels = true
summary.settings.hiddenModelIds = []
summary.settings.visibilityPolicy = { mode: 'blocklist', hiddenLanes: [], visibleIds: [] }
recalculate(summary.settings)
tree = render()
const reset = byTitle(tree, visibilityCopy('en').resetHelp)
assert.equal(reset.props.disabled, false, 'legacy group rules remain directly recoverable after the settings controls were consolidated')
reset.props.onClick()
await settle()
assert.deepEqual(writes.pop(), {
  visibilityPolicy: { mode: 'blocklist', hiddenLanes: [], visibleIds: [] },
  hideFreeModels: false,
  hideEacModels: false,
})

summary.catalog = Array.from({ length: 1001 }, (_, index) => ({
  id: `combo:${index}`, name: `Combo ${index}`, channel: 'combo', visibilityLane: 'combo', routable: true, availability: 'available',
}))
summary.settings.hideFreeModels = false
summary.settings.hideEacModels = false
recalculate(summary.settings)
tree = render()
const writesBeforeOversize = writes.length
byTitle(tree, 'Only Combos').props.onClick()
await settle()
assert.equal(writes.length, writesBeforeOversize, 'an oversized lane is rejected instead of silently truncated')
assert.equal(nodes(render()).some(node => node.props.role === 'alert'
  && JSON.stringify(node).includes(visibilityCopy('en').allowlistTooLarge)), true)

console.log('ok standalone visibility policy: lane blocklists, exact allowlists, combo independence and blocked selection')
