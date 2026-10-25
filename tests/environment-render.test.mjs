import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compile } from '@vue/compiler-dom'
import * as Vue from 'vue'
import { NSpace } from 'naive-ui'

// Use the real card template and NSpace so changes in conditional child layout are exercised.
const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
const start = source.indexOf('<n-grid-item v-for="tool in environmentTools"')
assert.ok(start >= 0)
const end = source.indexOf('</n-grid-item>', start) + '</n-grid-item>'.length
const { code } = compile('<div>' + source.slice(start, end) + '</div>', { mode: 'function', prefixIdentifiers: true, hoistStatic: false })
const render = new Function('Vue', code)(Vue)

function rendererFixture() {
  const node = (type, text = '') => ({ type, text, children: [], props: {}, parent: null })
  const remove = child => {
    if (!child.parent) return
    const siblings = child.parent.children
    const index = siblings.indexOf(child)
    if (index >= 0) siblings.splice(index, 1)
    child.parent = null
  }
  const renderer = Vue.createRenderer({
    createElement: type => node(type), createText: text => node('#text', text), createComment: text => node('#comment', text),
    setText: (target, text) => { target.text = text },
    setElementText: (target, text) => { for (const child of [...target.children]) remove(child); target.text = text },
    insert: (child, parent, anchor = null) => {
      remove(child)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index >= 0 ? index : parent.children.length, 0, child)
      child.parent = parent
    },
    remove, parentNode: target => target.parent,
    nextSibling: target => target.parent?.children[target.parent.children.indexOf(target) + 1] ?? null,
    patchProp: (target, key, previous, next) => { target.props[key] = next },
  })
  const component = name => Vue.defineComponent({ name, setup: (_, { slots }) => () => Vue.h(name, null, slots.default?.()) })
  const missing = name => ({ name, installed: false, managedInstalled: false, installVersions: ['3.11'], defaultInstallVersion: '3.11' })
  const state = Vue.reactive({
    environmentTools: ['Python', 'uv', 'Node.js'].map(missing), environmentIcons: {}, environmentMode: 'managed',
    environmentSelectedVersions: {}, environmentModeSaving: false, environmentChecking: false, environmentInstalling: null,
    t: { installed: 'Installed', notInstalled: 'Not installed', environmentSources: { managed: 'Launcher', system: 'Global' }, environmentPath: 'Path' },
    environmentActionsText: { install: 'Install', uninstall: 'Uninstall' },
    environmentVersionOptions: tool => tool.installVersions.map(value => ({ value, label: value })),
    isEnvironmentInstalling: () => false, installEnvironmentTool() {}, confirmEnvironmentUninstall() {},
  })
  const root = node('root')
  const app = renderer.createApp({
    components: { NSpace, NGridItem: component('grid-item'), NCard: component('card'), NText: component('text'), NTag: component('tag'), NSelect: component('select'), NButton: component('button') },
    setup: () => state, render,
  })
  app.mount(root)
  const find = (target, predicate) => [target, ...target.children.flatMap(child => find(child, predicate))].filter(predicate)
  const count = (card, className) => find(card, item => String(item.props.class ?? '').split(/\s+/).includes(className)).length
  const cards = () => find(root, item => item.type === 'card')
  return { state, missing, app, cards, count }
}

test('repeated Python install and uninstall keeps one install row and removes installed details', async () => {
  const f = rendererFixture()
  try {
    for (let cycle = 0; cycle < 4; cycle++) {
      assert.equal(f.cards().length, 3)
      assert.equal(f.count(f.cards()[0], 'environment-actions'), 1)
      assert.equal(f.count(f.cards()[0], 'environment-path'), 0)
      f.state.environmentTools[0] = { ...f.missing('Python'), installed: true, managedInstalled: true, source: 'managed', version: 'Python 3.11.17', path: 'C:\\Launcher\\python.exe' }
      await Vue.nextTick()
      assert.equal(f.count(f.cards()[0], 'environment-actions'), 0)
      assert.equal(f.count(f.cards()[0], 'environment-path'), 1)
      // The uninstall IPC replaces the full tool list with a new snapshot.
      f.state.environmentTools = ['Python', 'uv', 'Node.js'].map(f.missing)
      await Vue.nextTick()
      for (const card of f.cards()) {
        assert.equal(f.count(card, 'environment-actions'), 1)
        assert.equal(f.count(card, 'environment-path'), 0)
      }
    }
  } finally { f.app.unmount() }
})
