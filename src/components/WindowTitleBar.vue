<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { windowControlsMessages, type Language } from '../i18n/messages'

const props = defineProps<{ language: Language; dark: boolean }>()
const text = computed(() => windowControlsMessages[props.language])
const controls = window.kiraLauncher?.window
const maximized = ref(false)
let removeMaximizedListener: (() => void) | undefined

onMounted(() => {
  removeMaximizedListener = controls?.onMaximized((value) => { maximized.value = value })
  void controls?.isMaximized().then((value) => { maximized.value = value })
})
onBeforeUnmount(() => removeMaximizedListener?.())
</script>

<template>
  <header class="window-titlebar" :class="{ 'window-titlebar-dark': dark }">
    <div class="window-titlebar-brand">
      <img src="/icon.png" alt="" />
      <span>KiraAI Launcher</span>
    </div>
    <div v-if="controls" class="window-controls">
      <button type="button" :title="text.minimize" :aria-label="text.minimize" @click="controls.minimize()">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6.5h10" /></svg>
      </button>
      <button type="button" :title="maximized ? text.restore : text.maximize" :aria-label="maximized ? text.restore : text.maximize" @click="controls.toggleMaximize()">
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path v-if="maximized" d="M3.5 3.5v-2h7v7h-2 M1.5 3.5h7v7h-7z" />
          <path v-else d="M1.5 1.5h9v9h-9z" />
        </svg>
      </button>
      <button type="button" class="window-close" :title="text.close" :aria-label="text.close" @click="controls.close()">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m1.5 1.5 9 9m0-9-9 9" /></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.window-titlebar { height: 36px; display: flex; align-items: center; justify-content: space-between; color: #333; background: #fff; border-bottom: 1px solid #efeff5; user-select: none; -webkit-app-region: drag; }
.window-titlebar-dark { color: #eee; background: #18181c; border-bottom-color: rgba(255, 255, 255, .09); }
.window-titlebar-brand { display: flex; align-items: center; gap: 8px; padding-left: 12px; font-size: 12px; }
.window-titlebar-brand img { width: 18px; height: 18px; pointer-events: none; }
.window-controls { display: flex; align-self: stretch; -webkit-app-region: no-drag; }
.window-controls button { display: grid; place-items: center; width: 46px; padding: 0; border: 0; color: inherit; background: transparent; cursor: default; transition: background-color .2s ease, color .2s ease; }
.window-controls button:hover { background: rgba(0, 0, 0, .08); }
.window-titlebar-dark .window-controls button:hover { background: rgba(255, 255, 255, .12); }
.window-controls button:focus-visible { outline: 2px solid currentColor; outline-offset: -3px; }
.window-controls .window-close:hover, .window-titlebar-dark .window-controls .window-close:hover { color: #fff; background: #c42b1c; }
.window-controls .window-close:active, .window-titlebar-dark .window-controls .window-close:active { color: #fff; background: #a92317; }
.window-controls svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1; }
</style>