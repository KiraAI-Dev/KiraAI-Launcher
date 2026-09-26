<script setup lang="ts">
import { computed } from 'vue'
import { NAlert, NSpace, NStep, NSteps, NTag, NText, useThemeVars } from 'naive-ui'
import { projectOperationSteps, type ProjectOperation, type ProjectProgress } from '../../electron/types'
import { projectProgressMessages, type Language } from '../i18n/messages'

const props = defineProps<{
  operation: ProjectOperation
  progress: ProjectProgress
  status: 'running' | 'success' | 'error'
  language: Language
}>()

const themeVars = useThemeVars()
const text = computed(() => projectProgressMessages[props.language])
const steps = computed<readonly ProjectProgress['stage'][]>(() => projectOperationSteps[props.operation])
const current = computed(() => Math.max(0, steps.value.indexOf(props.progress.stage)) + 1)
const percentage = computed(() => {
  if (props.status === 'success') return 100
  const { completed, total } = props.progress
  return total && completed !== undefined ? Math.min(100, Math.max(0, completed / total * 100)) : undefined
})
const detail = computed(() => {
  const { stage, completed, total } = props.progress
  if (props.status === 'success') return props.operation === 'download' ? text.value.downloadSuccess : text.value.deploySuccess
  if (props.status === 'error') return text.value.error
  if (stage === 'download' && completed !== undefined) {
    const size = (bytes: number) => (bytes / 1024 / 1024).toFixed(1) + ' MiB'
    return text.value.received.replace('{size}', total ? size(completed) + ' / ' + size(total) : size(completed))
  }
  if (stage === 'extract' && completed !== undefined && total !== undefined) {
    return text.value.entries.replace('{current}', String(completed)).replace('{total}', String(total))
  }
  return text.value.waiting
})
</script>

<template>
  <n-space vertical :size="16" class="project-progress" :style="{ '--progress-color': themeVars.primaryColor, '--progress-success': themeVars.successColor, '--progress-error': themeVars.errorColor }">
    <n-space justify="space-between" align="center">
      <n-text>{{ text.step.replace('{current}', String(status === 'success' ? steps.length : current)).replace('{total}', String(steps.length)) }}</n-text>
      <n-tag size="small" :bordered="false" :type="status === 'success' ? 'success' : status === 'error' ? 'error' : 'info'">{{ text[status] }}</n-tag>
    </n-space>
    <n-steps vertical size="small" :current="status === 'success' ? steps.length : current" :status="status === 'error' ? 'error' : status === 'success' ? 'finish' : 'process'">
      <n-step v-for="stage in steps" :key="stage" :title="text.stages[stage]" />
    </n-steps>
    <div class="phase-progress" :class="status" role="progressbar" :aria-label="text.stages[progress.stage]" aria-valuemin="0" aria-valuemax="100" :aria-valuenow="percentage" :aria-valuetext="detail">
      <div class="phase-progress-fill" :class="{ indeterminate: percentage === undefined && status === 'running' }" :style="{ width: percentage === undefined ? '0%' : percentage + '%' }" />
    </div>
    <n-space justify="space-between">
      <n-text depth="3" role="status">{{ detail }}</n-text>
      <n-text v-if="percentage !== undefined" depth="3">{{ Math.floor(percentage) }}%</n-text>
    </n-space>
    <n-alert v-if="status === 'error'" type="error" :show-icon="false"><slot name="error" /></n-alert>
  </n-space>
</template>

<style scoped>
.phase-progress { height: 8px; overflow: hidden; border-radius: 4px; background: var(--n-border-color, #e0e0e6); }
.phase-progress-fill { height: 100%; border-radius: inherit; background: var(--progress-color); transition: width .15s ease; }
.phase-progress.success .phase-progress-fill { background: var(--progress-success); }
.phase-progress.error .phase-progress-fill { background: var(--progress-error); }
.phase-progress-fill.indeterminate { width: 35% !important; animation: progress-slide 1.4s ease-in-out infinite; }
@keyframes progress-slide { from { transform: translateX(-100%); } to { transform: translateX(290%); } }
@media (prefers-reduced-motion: reduce) { .phase-progress-fill.indeterminate { animation: none; width: 100% !important; opacity: .5; } }
</style>