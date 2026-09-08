<script setup lang="ts">
import { computed } from 'vue'
import { NTag } from 'naive-ui'
import DOMPurify from 'dompurify'
import { marked } from 'marked'

const props = defineProps<{
  title: string
  version: string
  markdown: string
  emptyText: string
}>()

const emit = defineEmits<{
  openLink: [url: string]
}>()

const renderedMarkdown = computed(() => {
  const html = marked.parse(props.markdown || props.emptyText, { async: false, gfm: true })
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul'],
    ALLOWED_ATTR: ['href', 'title'],
  })
})

function openLink(event: MouseEvent) {
  const link = event.target instanceof Element ? event.target.closest('a') : null
  const href = link?.getAttribute('href')
  if (!href) return
  event.preventDefault()
  emit('openLink', href)
}
</script>

<template>
  <div class="release-notes">
    <div class="release-heading">
      <strong>{{ title }}</strong>
      <n-tag type="info" size="small" :bordered="false">{{ version }}</n-tag>
    </div>
    <div class="release-body" @click="openLink" v-html="renderedMarkdown"></div>
  </div>
</template>

<style scoped>
.release-notes { position: relative; left: 50%; width: min(600px, calc(100vw - 390px)); padding: 16px; border: 1px solid var(--n-border-color); border-radius: 8px; background: #fafafc; transform: translateX(-50%); text-align: left; }
.release-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; color: var(--n-text-color); }
.release-body { max-height: 260px; overflow: auto; color: var(--n-text-color-2); font-size: 13px; line-height: 1.65; overflow-wrap: anywhere; }
.release-body :deep(> :first-child) { margin-top: 0; }
.release-body :deep(> :last-child) { margin-bottom: 0; }
.release-body :deep(h1), .release-body :deep(h2), .release-body :deep(h3), .release-body :deep(h4), .release-body :deep(h5), .release-body :deep(h6) { margin: 18px 0 8px; color: var(--n-text-color); line-height: 1.35; }
.release-body :deep(h1) { font-size: 20px; }
.release-body :deep(h2) { font-size: 18px; }
.release-body :deep(h3) { font-size: 16px; }
.release-body :deep(h4), .release-body :deep(h5), .release-body :deep(h6) { font-size: 14px; }
.release-body :deep(p) { margin: 8px 0; }
.release-body :deep(ul), .release-body :deep(ol) { margin: 8px 0; padding-left: 24px; }
.release-body :deep(li + li) { margin-top: 4px; }
.release-body :deep(a) { color: var(--accent-color); text-decoration: none; }
.release-body :deep(a:hover) { text-decoration: underline; }
.release-body :deep(code) { padding: 2px 5px; border-radius: 4px; background: rgba(128, 128, 128, .14); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 12px; }
.release-body :deep(pre) { margin: 10px 0; padding: 12px; overflow-x: auto; border-radius: 6px; background: rgba(128, 128, 128, .12); }
.release-body :deep(pre code) { padding: 0; background: transparent; }
.release-body :deep(blockquote) { margin: 10px 0; padding-left: 12px; border-left: 3px solid var(--accent-color); color: var(--n-text-color-3); }
.release-body :deep(hr) { margin: 16px 0; border: 0; border-top: 1px solid var(--n-border-color); }
.release-body :deep(table) { width: 100%; margin: 10px 0; border-collapse: collapse; }
.release-body :deep(th), .release-body :deep(td) { padding: 7px 9px; border: 1px solid var(--n-border-color); text-align: left; }
:global(.dark-app) .release-notes { background: #18181c; }
</style>
