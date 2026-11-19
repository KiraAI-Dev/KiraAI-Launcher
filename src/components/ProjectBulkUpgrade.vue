<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { NButton, NCheckbox, NList, NListItem, NModal, NProgress, NSpace, NTag, NText } from 'naive-ui'
import type { ProjectUpgradeCheck, ProjectUpgradeProgress } from '../../electron/types'
import { projectBulkUpgradeMessages, type Language } from '../i18n/messages'

type Row = {
  id: string
  name: string
  check?: ProjectUpgradeCheck
  state: 'checking' | 'available' | 'current' | 'skipped' | 'running' | 'success' | 'failed'
  progress?: ProjectUpgradeProgress
  error?: unknown
}

type SingleProject = { id: string; name: string; check: ProjectUpgradeCheck }

const props = defineProps<{
  show: boolean
  projects: readonly { id: string; name: string }[]
  singleProject?: SingleProject
  language: Language
  formatError: (error: unknown) => string
}>()
const emit = defineEmits<{ close: []; finished: []; checked: [id: string, result: { check: ProjectUpgradeCheck } | { error: unknown }] }>()
const singleProject = ref<SingleProject>()
const rows = ref<Row[]>([])
const selection = ref<string[]>([])
const checking = ref(false)
const updating = ref(false)
const text = computed(() => projectBulkUpgradeMessages[props.language])
const eligible = computed(() => rows.value.filter((row) => row.state === 'available'))
const selectedTargets = computed(() => {
  const selected = new Set(selection.value)
  return eligible.value.filter((row) => selected.has(row.id))
})
const confirmation = computed(() => {
  const versions = new Set(selectedTargets.value.flatMap((row) => row.check ? [row.check.targetVersion] : []))
  if (versions.size === 0) return ''
  const [version] = versions
  const project = singleProject.value
  if (project) return text.value.confirmSingle.replace('{version}', version).replace('{name}', () => project.name)
  return versions.size === 1 ? text.value.confirmVersion.replace('{version}', version) : text.value.confirmMultipleVersions
})
const busy = computed(() => checking.value || updating.value)
const api = window.kiraLauncher?.projects
let removeProgressListener: (() => void) | undefined

function setSelected(id: string, checked: boolean) {
  selection.value = checked ? [...selection.value, id] : selection.value.filter((item) => item !== id)
}

function statusType(state: Row['state']) {
  if (state === 'failed') return 'error'
  if (state === 'skipped') return 'warning'
  if (state === 'success') return 'success'
  if (state === 'available' || state === 'running') return 'info'
  return 'default'
}

function checkedState(check: ProjectUpgradeCheck): Row['state'] {
  return !check.updateAvailable ? 'current' : check.requiresStart ? 'skipped' : 'available'
}

async function checkProjects(refresh = false) {
  if (busy.value) return
  checking.value = true
  selection.value = []
  rows.value = props.projects.map(({ id, name }) => ({ id, name, state: 'checking' }))
  try {
    await Promise.all(rows.value.map(async (row) => {
      try {
        if (!api) throw new Error('BRIDGE_UNAVAILABLE')
        row.check = await api.checkUpgrade(row.id, refresh)
        row.state = checkedState(row.check)
        emit('checked', row.id, { check: row.check })
      } catch (error) {
        row.error = error
        row.state = 'skipped'
        emit('checked', row.id, { error })
      }
    }))
    selection.value = eligible.value.map((row) => row.id)
  } finally {
    checking.value = false
  }
}

async function updateSelected() {
  if (busy.value) return
  const targets = selectedTargets.value
  if (!targets.length) return
  updating.value = true
  selection.value = []
  try {
    await Promise.all(targets.map(async (row) => {
      if (!row.check) return
      row.state = 'running'
      row.progress = { phase: 'starting' }
      try {
        if (!api) throw new Error('BRIDGE_UNAVAILABLE')
        await api.upgrade(row.id, row.check.targetVersion)
        row.state = 'success'
      } catch (error) {
        row.error = error
        row.state = 'failed'
      }
    }))
    emit('finished')
  } finally {
    updating.value = false
  }
}

onMounted(() => {
  removeProgressListener = api?.onUpgradeProgress((id, progress) => {
    const row = rows.value.find((item) => item.id === id)
    if (row?.state === 'running') row.progress = progress
  })
})

watch(() => props.show, (show) => {
  if (!show) return
  const project = props.singleProject
  singleProject.value = project
  if (project) {
    const { id, name, check } = project
    const state = checkedState(check)
    rows.value = [{ id, name, check, state }]
    selection.value = state === 'available' ? [id] : []
  } else {
    void checkProjects()
  }
}, { immediate: true })

onBeforeUnmount(() => removeProgressListener?.())
</script>

<template>
  <n-modal :show="show" preset="card" :title="singleProject ? text.singleTitle : text.title" class="project-modal" content-scrollable :mask-closable="!busy" :closable="!busy" :close-on-esc="!busy" @update:show="(visible) => { if (!visible && !busy) emit('close') }">
    <n-space vertical :size="12">
      <n-text v-if="confirmation">{{ confirmation }}</n-text>
      <n-checkbox v-if="!singleProject" :checked="eligible.length > 0 && selection.length === eligible.length" :indeterminate="selection.length > 0 && selection.length < eligible.length" :disabled="busy || !eligible.length" @update:checked="(checked) => selection = checked ? eligible.map((row) => row.id) : []">{{ text.selectAll }}</n-checkbox>
      <n-list bordered>
        <n-list-item v-for="row in rows" :key="row.id">
          <n-space justify="space-between" align="center">
            <n-checkbox v-if="!singleProject && row.state === 'available'" :checked="selection.includes(row.id)" :disabled="busy" @update:checked="(checked) => setSelected(row.id, checked)">{{ row.name }}</n-checkbox>
            <strong v-else>{{ row.name }}</strong>
            <n-tag size="small" :bordered="false" :type="statusType(row.state)">{{ text.states[row.state] }}</n-tag>
          </n-space>
          <n-text v-if="row.check" depth="3">{{ row.check.updateAvailable ? text.versionChange.replace('{current}', row.check.currentVersion).replace('{target}', row.check.targetVersion) : text.version.replace('{current}', row.check.currentVersion) }}</n-text>
          <template v-if="row.state === 'running' && row.progress">
            <div><n-text depth="3" role="status">{{ text.phases[row.progress.phase] }}</n-text></div>
            <n-progress v-if="row.progress.percentage !== undefined" type="line" :percentage="row.progress.percentage" processing :aria-label="text.phases[row.progress.phase]" />
          </template>
          <div v-if="row.check?.requiresStart || row.error" class="upgrade-error"><n-text :type="row.state === 'failed' ? 'error' : 'warning'">{{ row.check?.requiresStart ? text.errors.PROJECT_UPGRADE_LOCAL_NOT_RUNNING : formatError(row.error) }}</n-text></div>
        </n-list-item>
      </n-list>
    </n-space>
    <template #footer>
      <n-space justify="end">
        <n-button :disabled="busy" @click="emit('close')">{{ text.close }}</n-button>
        <n-button v-if="!singleProject" :disabled="updating" :loading="checking" @click="checkProjects(true)">{{ text.checkAgain }}</n-button>
        <n-button v-if="!singleProject || selection.length || updating" type="primary" :disabled="busy || !selection.length" :loading="updating" @click="updateSelected">{{ singleProject ? text.update : text.apply.replace('{count}', String(selection.length)) }}</n-button>
      </n-space>
    </template>
  </n-modal>
</template>

<style scoped>
.upgrade-error { white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
