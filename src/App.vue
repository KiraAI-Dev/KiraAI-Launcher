<script setup lang="ts">
import { computed, defineComponent, h, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { darkTheme, enUS, NButton, NDialogProvider, NIcon, NMessageProvider, NTag, useDialog, useMessage, zhCN } from 'naive-ui'
import type { DataTableColumns, MenuOption } from 'naive-ui'
import { messages, projectAdvancedSettingsMessages, type Language } from './i18n/messages'
import { AddOutline, CloudOutline, CloudUploadOutline, CodeSlashOutline, CubeOutline, DownloadOutline, FolderOpenOutline, HardwareChipOutline, HomeOutline, InformationCircleOutline, LanguageOutline, LayersOutline, MoonOutline, OpenOutline, PlayOutline, RefreshOutline, RocketOutline, SettingsOutline, StopOutline, SunnyOutline, TrashOutline } from '@vicons/ionicons5'

type ViewKey = 'overview' | 'projects' | 'deployments' | 'environment' | 'settings' | 'about'
type ProjectCreationMode = 'local' | 'download' | 'cloud' | null

const activeView = ref<ViewKey>('overview')
const language = ref<Language>('zh-CN')
const themeMode = ref<'system' | 'light' | 'dark'>('system')
const themeColor = ref<'blue' | 'purple' | 'green' | 'orange'>('blue')
const systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)')
const systemPrefersDark = ref(systemThemeQuery.matches)
const syncSystemTheme = () => { systemPrefersDark.value = systemThemeQuery.matches }
const isDark = computed(() => themeMode.value === 'dark' || (themeMode.value === 'system' && systemPrefersDark.value))
const managedProjects = ref<ManagedProject[]>([])
const startedProjectIds = ref<string[]>([])
const runtimeNow = ref(Date.now())
const launcherVersion = ref('—')
const environmentTools = ref<EnvironmentTool[]>([])
const showNewProjectModal = ref(false)
const projectCreationMode = ref<ProjectCreationMode>(null)
const selectedLocalProject = ref<LocalProjectCandidate | null>(null)
const downloadDirectory = ref('')
const downloadProjectName = ref('kira-ai')
const cloudProjectName = ref('')
const cloudProjectUrl = ref('')
const cloudAccessToken = ref('')
const actionInProgress = ref(false)
const projectActionId = ref<string | null>(null)
const showProjectSettingsModal = ref(false)
const editingProject = ref<ManagedProject | null>(null)
const projectSettingsName = ref('')
const projectSettingsPort = ref<number | null>(null)
const projectSettingsUrl = ref('')
const projectSettingsAccessToken = ref('')
const projectSettingsLaunchArgs = ref('')
const projectSettingsEnvironmentVariables = ref('')
const projectSettingsSaving = ref(false)
const projectsRefreshing = ref(false)
const updateChecking = ref(false)
const updateCheckResult = ref<LauncherUpdateCheck | null>(null)
const updateCheckError = ref('')
const messageHost = ref<{ success: (content: string) => unknown } | null>(null)
const dialogHost = ref<ReturnType<typeof useDialog> | null>(null)
const MessageHost = defineComponent({
  setup(_props, { expose }) {
    expose(useMessage())
    return () => null
  },
})
const DialogHost = defineComponent({
  setup(_props, { expose }) {
    expose(useDialog())
    return () => null
  },
})
const environmentChecking = ref(false)
const projectError = ref('')
const closeReminder = ref(true)
const autoUpdate = ref(true)
const closeAction = ref('minimize')
const webuiOpenMode = ref<LauncherSettings['webuiOpenMode']>('launcher')
const settingsReady = ref(false)
const t = computed(() => messages[language.value])
const cloudConnectionText = computed(() => t.value.cloudConnectionText)
const aboutText = computed(() => t.value.aboutText)
const projectActionText = computed(() => t.value.projectActions)
const localizedErrors = computed(() => t.value.errors)
const projectSettingsErrors = computed(() => t.value.projectSettingsErrors)
const projectAdvancedSettingsText = computed(() => projectAdvancedSettingsMessages[language.value])
const localPortUnavailableMessage = computed(() => t.value.localPortUnavailable)
const bridgeUnavailableMessage = computed(() => t.value.bridgeUnavailable)
const palettes = {
  blue: { primary: '#2080f0', hover: '#4098fc', pressed: '#1060c9' },
  purple: { primary: '#7454db', hover: '#8a70e6', pressed: '#5d3fc2' },
  green: { primary: '#18a058', hover: '#36ad6a', pressed: '#0c7a43' },
  orange: { primary: '#f08c2e', hover: '#f5a04a', pressed: '#d66f10' },
} as const
const activePalette = computed(() => palettes[themeColor.value])
const themeOverrides = computed(() => ({
  common: { borderRadius: '10px', primaryColor: activePalette.value.primary, primaryColorHover: activePalette.value.hover, primaryColorPressed: activePalette.value.pressed },
  Menu: { itemHeight: '42px', itemBorderRadius: '10px' },
  Card: { borderRadius: '10px' },
  Switch: { railColorActive: activePalette.value.primary },
}))
const menuOptions = computed<MenuOption[]>(() => [
  { label: t.value.overview, key: 'overview', icon: () => h(HomeOutline) },
  { label: t.value.projects, key: 'projects', icon: () => h(LayersOutline) },
  { label: t.value.deployments, key: 'deployments', icon: () => h(RocketOutline) },
  { label: t.value.environment, key: 'environment', icon: () => h(HardwareChipOutline) },
])
const settingsMenu = computed<MenuOption[]>(() => [
  { label: t.value.settings, key: 'settings', icon: () => h(SettingsOutline) },
  { label: aboutText.value.menu, key: 'about', icon: () => h(InformationCircleOutline) },
])
const languageOptions = computed(() => [{ label: t.value.chinese, value: 'zh-CN' }, { label: t.value.english, value: 'en-US' }])
const themeOptions = computed(() => [{ label: t.value.system, value: 'system' }, { label: t.value.light, value: 'light' }, { label: t.value.dark, value: 'dark' }])
const colorOptions = computed(() => (Object.keys(palettes) as Array<keyof typeof palettes>).map((value) => ({ label: t.value[value], value })))
const closeOptions = computed(() => [{ label: t.value.minimize, value: 'minimize' }, { label: t.value.quit, value: 'quit' }])
const webuiOpenModeOptions = computed(() => [{ label: t.value.launcherPage, value: 'launcher' }, { label: t.value.systemBrowser, value: 'browser' }])
const projectTableText = computed(() => t.value.projectTable)
const viewTitle = computed(() => ({ overview: t.value.overview, projects: t.value.projects, deployments: t.value.deployments, environment: t.value.environment, settings: t.value.settings, about: aboutText.value.menu })[activeView.value])
const cloudProjectCount = computed(() => managedProjects.value.filter((project) => project.type === 'cloud').length)
const activeDeploymentCount = computed(() => cloudProjectCount.value + startedProjectIds.value.length)
const recentProjects = computed(() => [...managedProjects.value].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)).slice(0, 5))
const overviewProjectColumns = computed<DataTableColumns<ManagedProject>>(() => [
  { title: t.value.project, key: 'name', minWidth: 260, render: (row) => h('div', { class: 'managed-project-name' }, [h('strong', row.name), h(NTag, { size: 'small', bordered: false, type: row.type === 'local' ? 'info' : 'success' }, { default: () => row.type === 'local' ? t.value.localType : t.value.cloudType }), h('small', row.type === 'local' ? row.projectPath : row.url)]) },
  { title: projectTableText.value.uptime, key: 'runtimeStartedAt', width: 125, render: (row) => formatRuntimeDuration(row.runtimeStartedAt) },
  { title: t.value.addedAt, key: 'createdAt', width: 175, render: (row) => formatCreatedAt(row.createdAt) },
  { title: t.value.status, key: 'status', width: 120, render: (row) => h(NTag, { type: row.type === 'cloud' || startedProjectIds.value.includes(row.id) ? 'success' : 'default', size: 'small', bordered: false }, { default: () => row.type === 'cloud' ? t.value.connected : startedProjectIds.value.includes(row.id) ? t.value.running : projectTableText.value.stopped }) },
])
const managedProjectColumns = computed<DataTableColumns<ManagedProject>>(() => [
  { title: t.value.project, key: 'name', minWidth: 250, render: (row) => h('div', { class: 'managed-project-name' }, [h('strong', row.name), h(NTag, { size: 'small', bordered: false, type: row.type === 'local' ? 'info' : 'success' }, { default: () => row.type === 'local' ? t.value.localType : t.value.cloudType }), h('small', row.type === 'local' ? row.projectPath : row.url)]) },
  { title: t.value.status, key: 'status', width: 130, render: (row) => h(NTag, { size: 'small', bordered: false, type: row.type === 'cloud' || startedProjectIds.value.includes(row.id) ? 'success' : 'default' }, { default: () => row.type === 'cloud' ? t.value.connected : startedProjectIds.value.includes(row.id) ? t.value.running : projectTableText.value.stopped }) },
  { title: projectTableText.value.port, key: 'port', width: 105, render: (row) => row.type === 'local' ? String(row.port ?? 5267) : '—' },
  { title: projectTableText.value.version, key: 'version', width: 120, render: (row) => row.version ?? '—' },
  { title: projectTableText.value.uptime, key: 'runtimeStartedAt', width: 125, render: (row) => formatRuntimeDuration(row.runtimeStartedAt) },
  { title: projectTableText.value.actions, key: 'actions', width: 196, fixed: 'right', render: (row) => {
    const isRunning = startedProjectIds.value.includes(row.id)
    return h('div', { class: 'managed-project-actions' }, [
      row.type === 'local' ? h(NButton, {
        circle: true,
        quaternary: true,
        type: isRunning ? 'error' : 'success',
        title: isRunning ? projectActionText.value.stop : projectActionText.value.start,
        loading: projectActionId.value === row.id,
        disabled: actionInProgress.value && projectActionId.value !== row.id,
        onClick: () => void (isRunning ? stopProject(row.id) : startProject(row.id)),
      }, { icon: () => h(NIcon, { component: isRunning ? StopOutline : PlayOutline }) }) : null,
      h(NButton, { circle: true, quaternary: true, title: projectActionText.value.openWebui, disabled: actionInProgress.value, onClick: () => void openWebuiProject(row.id) }, { icon: () => h(NIcon, { component: OpenOutline }) }),
      row.type === 'local' ? h(NButton, { circle: true, quaternary: true, title: projectActionText.value.openFolder, disabled: actionInProgress.value, onClick: () => void openProjectFolder(row.id) }, { icon: () => h(NIcon, { component: FolderOpenOutline }) }) : null,
      h(NButton, { circle: true, quaternary: true, title: projectActionText.value.settings, disabled: actionInProgress.value, onClick: () => openProjectSettings(row) }, { icon: () => h(NIcon, { component: SettingsOutline }) }),
      h(NButton, { circle: true, quaternary: true, type: 'error', title: projectActionText.value.remove, disabled: actionInProgress.value, onClick: () => void removeManagedProject(row) }, { icon: () => h(NIcon, { component: TrashOutline }) }),
    ])
  } },
])
const recentProjectRowProps = () => ({ onClick: () => { activeView.value = 'projects' } })

function formatCreatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(language.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatRuntimeDuration(runtimeStartedAt: number | undefined) {
  if (typeof runtimeStartedAt !== 'number' || !Number.isFinite(runtimeStartedAt) || runtimeStartedAt <= 0) return cloudConnectionText.value.unavailable
  const seconds = Math.max(0, Math.floor((runtimeNow.value - runtimeStartedAt) / 1000))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  const remainingSeconds = seconds % 60
  const clock = [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, '0')).join(':')
  return days > 0 ? `${days}${cloudConnectionText.value.day} ${clock}` : clock
}

function getErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return t.value.operationFailed
  if (error.message === "BRIDGE_UNAVAILABLE") return bridgeUnavailableMessage.value
  if (error.message === 'LOCAL_PORT_UNAVAILABLE') return localPortUnavailableMessage.value
  if (error.message === 'PROJECT_LAUNCH_ARGUMENTS_INVALID') return projectAdvancedSettingsText.value.launchArgsInvalid
  if (error.message === 'PROJECT_ENVIRONMENT_VARIABLES_INVALID') return projectAdvancedSettingsText.value.environmentVariablesInvalid
  if (error.message in projectSettingsErrors.value) return projectSettingsErrors.value[error.message as keyof typeof projectSettingsErrors.value]
  if (["CLOUD_AUTH_CONFIG_INVALID", "CLOUD_LOGIN_FAILED", "CLOUD_OVERVIEW_UNAVAILABLE", "CLOUD_OVERVIEW_INVALID", "CLOUD_VERSION_UNAVAILABLE", "CLOUD_VERSION_INVALID"].includes(error.message)) return localizedErrors.value.CLOUD_WEBUI_UNAVAILABLE
  if (!(error.message in localizedErrors.value)) return t.value.operationFailed
  return localizedErrors.value[error.message as keyof typeof localizedErrors.value]
}

function requireLauncherBridge() {
  if (!window.kiraLauncher) throw new Error('BRIDGE_UNAVAILABLE')
  return window.kiraLauncher
}

async function refreshManagedProjects() {
  try {
    const overview = await requireLauncherBridge().overview.load()
    launcherVersion.value = overview.launcherVersion
    managedProjects.value = overview.projects
    startedProjectIds.value = overview.activeLocalProjectIds
  } catch (error) {
    projectError.value = getErrorMessage(error)
  }
}

async function refreshProjectRuntime() {
  projectsRefreshing.value = true
  await refreshManagedProjects()
  projectsRefreshing.value = false
}

async function checkForUpdates() {
  updateChecking.value = true
  updateCheckError.value = ''
  updateCheckResult.value = null
  try {
    updateCheckResult.value = await requireLauncherBridge().updates.check()
  } catch {
    updateCheckError.value = aboutText.value.failed
  } finally {
    updateChecking.value = false
  }
}

function upsertManagedProject(project: ManagedProject) {
  const index = managedProjects.value.findIndex((item) => item.id === project.id)
  managedProjects.value = index === -1
    ? [...managedProjects.value, project]
    : managedProjects.value.map((item) => item.id === project.id ? project : item)
}

async function refreshEnvironment() {
  environmentChecking.value = true
  try {
    environmentTools.value = await requireLauncherBridge().environment.check()
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    environmentChecking.value = false
  }
}

function openNewProjectModal() {
  projectCreationMode.value = null
  projectError.value = ''
  selectedLocalProject.value = null
  downloadDirectory.value = ''
  cloudProjectName.value = ''
  cloudProjectUrl.value = ''
  cloudAccessToken.value = ''
  showNewProjectModal.value = true
}

async function chooseLocalProject() {
  projectError.value = ''
  try {
    selectedLocalProject.value = await requireLauncherBridge().projects.chooseLocal()
  } catch (error) {
    projectError.value = getErrorMessage(error)
  }
}

async function addLocalProject() {
  if (!selectedLocalProject.value) return
  actionInProgress.value = true
  projectError.value = ''
  try {
    const project = await requireLauncherBridge().projects.addLocal(selectedLocalProject.value.projectPath)
    upsertManagedProject(project)
    showNewProjectModal.value = false
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    actionInProgress.value = false
  }
}

async function chooseDownloadDirectory() {
  projectError.value = ''
  try {
    downloadDirectory.value = await requireLauncherBridge().projects.chooseDownloadDirectory() ?? ''
  } catch (error) {
    projectError.value = getErrorMessage(error)
  }
}

async function downloadProject() {
  if (!downloadDirectory.value || !downloadProjectName.value.trim()) return
  actionInProgress.value = true
  projectError.value = ''
  try {
    const project = await requireLauncherBridge().projects.download({ parentPath: downloadDirectory.value, name: downloadProjectName.value.trim() })
    upsertManagedProject(project)
    showNewProjectModal.value = false
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    actionInProgress.value = false
  }
}

async function connectCloudProject() {
  if (!cloudProjectName.value.trim() || !cloudProjectUrl.value.trim()) return
  actionInProgress.value = true
  projectError.value = ''
  try {
    const project = await requireLauncherBridge().projects.connectCloud({ name: cloudProjectName.value.trim(), url: cloudProjectUrl.value.trim(), accessToken: cloudAccessToken.value || undefined })
    upsertManagedProject(project)
    showNewProjectModal.value = false
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    actionInProgress.value = false
  }
}

async function startProject(id: string) {
  actionInProgress.value = true
  projectActionId.value = id
  projectError.value = ''
  try {
    await requireLauncherBridge().projects.start(id)
    await refreshManagedProjects()
    messageHost.value?.success(projectActionText.value.started)
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    projectActionId.value = null
    actionInProgress.value = false
  }
}

async function stopProject(id: string) {
  actionInProgress.value = true
  projectActionId.value = id
  projectError.value = ''
  try {
    await requireLauncherBridge().projects.stop(id)
    await refreshManagedProjects()
    messageHost.value?.success(projectActionText.value.stopped)
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    projectActionId.value = null
    actionInProgress.value = false
  }
}

async function openWebuiProject(id: string) {
  try {
    await requireLauncherBridge().projects.open(id)
  } catch (error) {
    projectError.value = getErrorMessage(error)
  }
}

async function openProjectFolder(id: string) {
  try {
    await requireLauncherBridge().projects.openFolder(id)
  } catch (error) {
    projectError.value = getErrorMessage(error)
  }
}

function openProjectSettings(project: ManagedProject) {
  projectError.value = ''
  editingProject.value = project
  projectSettingsName.value = project.name
  projectSettingsPort.value = project.type === 'local' ? project.port ?? 5267 : null
  projectSettingsUrl.value = project.type === 'cloud' ? project.url ?? '' : ''
  projectSettingsAccessToken.value = ''
  projectSettingsLaunchArgs.value = (project.launchArgs ?? []).map(formatLaunchArgument).join(' ')
  projectSettingsEnvironmentVariables.value = Object.entries(project.environmentVariables ?? {}).map(([key, value]) => `${key}=${value}`).join('\n')
  showProjectSettingsModal.value = true
}

function formatLaunchArgument(argument: string) {
  if (argument && !/[\s'"\\]/.test(argument)) return argument
  if (!argument.includes("'")) return `'${argument}'`
  return `"${argument.replace(/(["\\])/g, '\\$1')}"`
}

function parseProjectSettingsLaunchArgs() {
  const args: string[] = []
  let argument = ''
  let quote: '"' | "'" | null = null
  let hasArgument = false
  const input = projectSettingsLaunchArgs.value
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]
    if (quote) {
      if (character === quote) {
        quote = null
      } else if (quote === '"' && character === '\\' && (input[index + 1] === '"' || input[index + 1] === '\\')) {
        argument += input[index + 1]
        index += 1
      } else {
        argument += character
      }
      hasArgument = true
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      hasArgument = true
    } else if (/\s/.test(character)) {
      if (hasArgument) {
        args.push(argument)
        argument = ''
        hasArgument = false
      }
    } else if (character === '\\' && (input[index + 1] === '"' || input[index + 1] === "'" || input[index + 1] === '\\' || /\s/.test(input[index + 1] ?? ''))) {
      argument += input[index + 1]
      index += 1
      hasArgument = true
    } else {
      argument += character
      hasArgument = true
    }
  }
  if (quote) throw new Error('PROJECT_LAUNCH_ARGUMENTS_INVALID')
  if (hasArgument) args.push(argument)
  return args
}

function parseProjectSettingsEnvironmentVariables() {
  const variables: Record<string, string> = {}
  for (const line of projectSettingsEnvironmentVariables.value.split(/\r?\n/)) {
    if (!line.trim()) continue
    const separator = line.indexOf('=')
    const key = line.slice(0, separator).trim()
    if (separator <= 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new Error('PROJECT_ENVIRONMENT_VARIABLES_INVALID')
    }
    variables[key] = line.slice(separator + 1)
  }
  return variables
}

async function saveProjectSettings() {
  const project = editingProject.value
  if (!project) return
  projectSettingsSaving.value = true
  projectError.value = ''
  try {
    const updatedProject = project.type === 'local'
      ? await requireLauncherBridge().projects.update({ id: project.id, name: projectSettingsName.value, port: projectSettingsPort.value, launchArgs: parseProjectSettingsLaunchArgs(), environmentVariables: parseProjectSettingsEnvironmentVariables() })
      : await requireLauncherBridge().projects.update({ id: project.id, name: projectSettingsName.value, url: projectSettingsUrl.value, accessToken: projectSettingsAccessToken.value || undefined })
    upsertManagedProject(updatedProject)
    showProjectSettingsModal.value = false
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    projectSettingsSaving.value = false
  }
}

function removeManagedProject(project: ManagedProject) {
  const confirmation = projectActionText.value.confirmRemove.replace('{name}', project.name)
  dialogHost.value?.warning({
    title: projectActionText.value.remove,
    content: confirmation,
    positiveText: projectActionText.value.remove,
    negativeText: t.value.cancel,
    onPositiveClick: () => { void confirmRemoveManagedProject(project) },
  })
}

async function confirmRemoveManagedProject(project: ManagedProject) {
  actionInProgress.value = true
  projectError.value = ''
  try {
    await requireLauncherBridge().projects.remove(project.id)
    managedProjects.value = managedProjects.value.filter((item) => item.id !== project.id)
    startedProjectIds.value = startedProjectIds.value.filter((id) => id !== project.id)
  } catch (error) {
    projectError.value = getErrorMessage(error)
  } finally {
    actionInProgress.value = false
  }
}

async function restoreSettings() {
  const savedSettings = await window.kiraLauncher?.settings.load()
  if (savedSettings) {
    themeMode.value = savedSettings.themeMode
    themeColor.value = savedSettings.themeColor
    language.value = savedSettings.language
    webuiOpenMode.value = savedSettings.webuiOpenMode
    closeAction.value = savedSettings.closeAction
    closeReminder.value = savedSettings.closeReminder
    autoUpdate.value = savedSettings.autoUpdate
  }
  settingsReady.value = true
}

watch([themeMode, themeColor, language, webuiOpenMode, closeAction, closeReminder, autoUpdate], () => {
  if (!settingsReady.value || !window.kiraLauncher) return
  void window.kiraLauncher.settings.save({
    themeMode: themeMode.value,
    themeColor: themeColor.value,
    language: language.value,
    webuiOpenMode: webuiOpenMode.value,
    closeAction: closeAction.value as LauncherSettings['closeAction'],
    closeReminder: closeReminder.value,
    autoUpdate: autoUpdate.value,
  })
})

let runtimeTimer: number | undefined

onMounted(() => {
  systemThemeQuery.addEventListener('change', syncSystemTheme)
  runtimeTimer = window.setInterval(() => { runtimeNow.value = Date.now() }, 1000)
  void restoreSettings()
  void refreshManagedProjects()
  void refreshEnvironment()
})
onBeforeUnmount(() => {
  systemThemeQuery.removeEventListener('change', syncSystemTheme)
  if (runtimeTimer) window.clearInterval(runtimeTimer)
})
</script>

<template>
  <n-config-provider :theme="isDark ? darkTheme : null" :locale="language === 'zh-CN' ? zhCN : enUS" :theme-overrides="themeOverrides">
    <n-dialog-provider>
    <n-message-provider>
      <MessageHost ref="messageHost" />
      <DialogHost ref="dialogHost" />
      <n-layout has-sider native-scrollbar class="app-layout" :class="{ 'dark-app': isDark }" :style="{ '--accent-color': activePalette.primary }">
      <n-layout-sider bordered collapse-mode="width" :collapsed-width="64" :width="238" show-trigger>
        <div class="brand"><n-icon :component="CubeOutline" size="25" :color="activePalette.primary" /><span>KiraAI Launcher</span></div>
        <n-menu v-model:value="activeView" :options="menuOptions" />
        <div class="sider-bottom"><n-menu v-model:value="activeView" :options="settingsMenu" /></div>
      </n-layout-sider>
      <n-layout native-scrollbar class="right-layout">
        <n-layout-content native-scrollbar class="right-content" content-style="padding: 32px 38px;">
          <template v-if="activeView === 'overview'"><n-space vertical :size="28">
            <div class="page-heading"><div><h1>{{ t.welcome }}</h1><p>{{ t.overviewSub }}</p></div><n-space><n-button @click="activeView = 'projects'"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t.openProject }}</n-button><n-button type="primary" @click="openNewProjectModal"><template #icon><n-icon :component="AddOutline" /></template>{{ t.newProject }}</n-button></n-space></div>
            <n-grid :cols="4" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
              <n-grid-item span="4 s:2 m:1"><n-card size="small"><n-statistic :label="t.totalProjects" :value="managedProjects.length"><template #prefix><n-icon :component="LayersOutline" /></template></n-statistic><template #footer><n-text depth="3">{{ t.managedProjectsSummary }}</n-text></template></n-card></n-grid-item>
              <n-grid-item span="4 s:2 m:1"><n-card size="small"><n-statistic :label="t.activeDeployments" :value="activeDeploymentCount"><template #prefix><n-icon :component="RocketOutline" /></template></n-statistic><template #footer><n-text type="success">{{ t.activeDeploymentsSummary }}</n-text></template></n-card></n-grid-item>
              <n-grid-item span="4 s:2 m:1"><n-card size="small"><n-statistic :label="t.cloudInstances" :value="cloudProjectCount"><template #prefix><n-icon :component="CloudUploadOutline" /></template></n-statistic><template #footer><n-text depth="3">{{ t.connectedCloudInstances }}</n-text></template></n-card></n-grid-item>
              <n-grid-item span="4 s:2 m:1"><n-card size="small"><n-statistic :label="t.launcherVersion" :value="launcherVersion"><template #prefix><n-icon :component="CodeSlashOutline" /></template></n-statistic><template #footer><n-text depth="3">{{ t.applicationVersion }}</n-text></template></n-card></n-grid-item>
            </n-grid>
            <n-grid :cols="3" :x-gap="16" :y-gap="16" responsive="screen" item-responsive>
              <n-grid-item span="3 m:2"><n-card :title="t.recentManagedProjects" size="small"><template #header-extra><n-button text type="primary" @click="activeView = 'projects'">{{ t.allProjects }}</n-button></template><n-empty v-if="!recentProjects.length" :description="t.noRecentProjects" size="small" /><n-data-table v-else :columns="overviewProjectColumns" :data="recentProjects" :bordered="false" :single-line="false" :row-props="recentProjectRowProps" /></n-card></n-grid-item>
              <n-grid-item span="3 m:1"><n-card :title="t.quickStart" size="small"><n-space vertical :size="12"><n-button block @click="activeView = 'projects'"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t.openLocal }}</n-button><n-button block><template #icon><n-icon :component="CloudUploadOutline" /></template>{{ t.connectCloud }}</n-button><n-button block><template #icon><n-icon :component="CodeSlashOutline" /></template>{{ t.createTemplate }}</n-button></n-space><n-divider /><n-text depth="3">{{ t.comingSoon }}</n-text></n-card></n-grid-item>
            </n-grid>
          </n-space></template>
          <template v-else-if="activeView === 'projects'"><n-space vertical :size="24"><div class="page-heading"><div><h1>{{ t.projects }}</h1><p>{{ t.manageProjects }}</p></div><n-space><n-button :loading="projectsRefreshing" @click="refreshProjectRuntime"><template #icon><n-icon :component="RefreshOutline" /></template>{{ t.refresh }}</n-button><n-button type="primary" @click="openNewProjectModal"><template #icon><n-icon :component="AddOutline" /></template>{{ t.newProject }}</n-button></n-space></div><n-alert v-if="projectError" type="error" :title="t.operationFailed" closable @close="projectError = ''">{{ projectError }}</n-alert><n-card><n-empty v-if="!managedProjects.length" :description="t.noManagedProjects"><template #extra><n-text depth="3">{{ t.noManagedProjectsSub }}</n-text></template><n-button type="primary" @click="openNewProjectModal">{{ t.newProject }}</n-button></n-empty><n-data-table v-else :columns="managedProjectColumns" :data="managedProjects" :bordered="false" :single-line="false" :scroll-x="1000" /></n-card></n-space></template>
          <template v-else-if="activeView === 'environment'"><n-space vertical :size="24" class="environment-page"><div class="page-heading"><div><h1>{{ t.environment }}</h1><p>{{ t.environmentSub }}</p></div><n-button :loading="environmentChecking" @click="refreshEnvironment">{{ environmentChecking ? t.checking : t.refresh }}</n-button></div><n-grid :cols="3" :x-gap="16" :y-gap="16" responsive="screen" item-responsive><n-grid-item v-for="tool in environmentTools" :key="tool.name" span="3 m:1"><n-card size="small" class="environment-card"><n-space vertical :size="16"><n-space justify="space-between" align="center"><n-space align="center"><n-icon :component="tool.name === 'Python' ? CodeSlashOutline : tool.name === 'uv' ? CubeOutline : HardwareChipOutline" :color="activePalette.primary" size="24" /><strong>{{ tool.name }}</strong></n-space><n-tag :type="tool.installed ? 'success' : 'error'" size="small" :bordered="false">{{ tool.installed ? t.installed : t.notInstalled }}</n-tag></n-space><n-text depth="3">{{ tool.version || '—' }}</n-text><div class="environment-path"><span>{{ t.environmentPath }}</span><code>{{ tool.path || '—' }}</code></div></n-space></n-card></n-grid-item></n-grid></n-space></template>
          <template v-else-if="activeView === 'settings'"><n-space vertical :size="30" class="settings-page"><div class="page-heading"><div><h1>{{ t.settings }}</h1><p>{{ t.settingsSub }}</p></div></div>
            <section><h2 class="settings-section-title">{{ t.appearance }}</h2><n-space vertical :size="14"><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><n-icon :component="isDark ? MoonOutline : SunnyOutline" size="22" /><div><h3>{{ t.theme }}</h3><p>{{ t.themeSub }}</p></div></div><n-select v-model:value="themeMode" :options="themeOptions" style="width: 190px" /></div><n-text depth="3" class="setting-hint">{{ t.themeHint }}</n-text></n-card><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><span class="palette-dot" :style="{ backgroundColor: activePalette.primary }"></span><div><h3>{{ t.themeColor }}</h3><p>{{ t.themeColorSub }}</p></div></div><n-select v-model:value="themeColor" :options="colorOptions" style="width: 190px" /></div></n-card><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><n-icon :component="LanguageOutline" size="22" /><div><h3>{{ t.language }}</h3><p>{{ t.languageSub }}</p></div></div><n-select v-model:value="language" :options="languageOptions" style="width: 190px" /></div><n-text depth="3" class="setting-hint">{{ t.languageHint }}</n-text></n-card></n-space></section>
            <section><h2 class="settings-section-title">{{ t.behavior }}</h2><n-space vertical :size="14"><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><div><h3>{{ t.webuiOpenMode }}</h3><p>{{ t.webuiOpenModeSub }}</p></div></div><n-select v-model:value="webuiOpenMode" :options="webuiOpenModeOptions" style="width: 210px" /></div></n-card><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><div><h3>{{ t.closeWhen }}</h3><p>{{ t.closeWhenSub }}</p></div></div><n-select v-model:value="closeAction" :options="closeOptions" style="width: 210px" /></div></n-card><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><div><h3>{{ t.closeReminder }}</h3><p>{{ t.closeReminderSub }}</p></div></div><n-switch v-model:value="closeReminder" /></div></n-card><n-card size="small" class="setting-card"><div class="setting-row"><div class="setting-copy"><div><h3>{{ t.autoUpdate }}</h3><p>{{ t.autoUpdateSub }}</p></div></div><n-switch v-model:value="autoUpdate" /></div></n-card></n-space></section>
          </n-space></template>
          <template v-else-if="activeView === 'about'"><div class="about-page"><n-card class="about-card" :bordered="false"><n-space vertical align="center" :size="18"><img src="/icon.png" class="about-icon" alt="KiraAI Launcher" /><div class="about-copy"><h1>{{ aboutText.title }}</h1><p>{{ aboutText.version }} {{ launcherVersion }}</p></div><n-button type="primary" :loading="updateChecking" @click="checkForUpdates"><template #icon><n-icon :component="RefreshOutline" /></template>{{ updateChecking ? aboutText.checking : aboutText.check }}</n-button><n-alert v-if="updateCheckResult" :type="updateCheckResult.updateAvailable ? 'info' : 'success'" :show-icon="false" class="about-update-result">{{ updateCheckResult.updateAvailable ? aboutText.available.replace('{version}', updateCheckResult.latestVersion) : aboutText.latest.replace('{version}', updateCheckResult.latestVersion) }}</n-alert><n-alert v-else-if="updateCheckError" type="error" :show-icon="false" class="about-update-result">{{ updateCheckError }}</n-alert></n-space></n-card></div></template>
          <template v-else><div class="placeholder"><n-empty :description="`${viewTitle} ${t.moduleComing}`" size="large"><template #icon><n-icon :component="RocketOutline" /></template><n-button type="primary" @click="activeView = 'overview'">{{ t.backOverview }}</n-button></n-empty></div></template>
        </n-layout-content>
      </n-layout>
      </n-layout>
      <n-modal v-model:show="showNewProjectModal" preset="card" :title="t.newProjectTitle" class="project-modal" :mask-closable="!actionInProgress">
      <n-space v-if="projectCreationMode === null" vertical :size="12"><n-text depth="3">{{ t.chooseProjectMethod }}</n-text><div class="project-source-grid"><button class="project-source-option" type="button" @click="projectCreationMode = 'local'"><n-icon :component="FolderOpenOutline" :color="activePalette.primary" size="26" /><strong>{{ t.localProject }}</strong><span>{{ t.localProjectSub }}</span></button><button class="project-source-option" type="button" @click="projectCreationMode = 'download'"><n-icon :component="DownloadOutline" :color="activePalette.primary" size="26" /><strong>{{ t.downloadProject }}</strong><span>{{ t.downloadProjectSub }}</span></button><button class="project-source-option" type="button" @click="projectCreationMode = 'cloud'"><n-icon :component="CloudOutline" :color="activePalette.primary" size="26" /><strong>{{ t.cloudProject }}</strong><span>{{ t.cloudProjectSub }}</span></button></div></n-space>
      <n-space v-else-if="projectCreationMode === 'local'" vertical :size="18"><div><strong>{{ t.selectLocalProject }}</strong><p class="modal-hint">{{ t.selectLocalHint }}</p></div><n-button block @click="chooseLocalProject"><template #icon><n-icon :component="FolderOpenOutline" /></template>{{ t.selectLocalProject }}</n-button><n-alert v-if="selectedLocalProject" type="success" :show-icon="false">{{ t.selectedDirectory }}：{{ selectedLocalProject.projectPath }}</n-alert><n-alert v-if="projectError" type="error" :show-icon="false">{{ projectError }}</n-alert><n-space justify="end"><n-button :disabled="actionInProgress" @click="projectCreationMode = null">{{ t.back }}</n-button><n-button type="primary" :disabled="!selectedLocalProject" :loading="actionInProgress" @click="addLocalProject">{{ t.manage }}</n-button></n-space></n-space>
      <n-space v-else-if="projectCreationMode === 'download'" vertical :size="18"><n-form label-placement="top"><n-form-item :label="t.downloadDirectory"><n-input :value="downloadDirectory" readonly :placeholder="t.chooseDirectory"><template #suffix><n-button text type="primary" @click="chooseDownloadDirectory">{{ t.chooseDirectory }}</n-button></template></n-input></n-form-item><n-form-item :label="t.projectName"><n-input v-model:value="downloadProjectName" :placeholder="t.projectName" /><template #feedback>{{ t.projectNameHint }}</template></n-form-item></n-form><n-alert v-if="projectError" type="error" :show-icon="false">{{ projectError }}</n-alert><n-space justify="end"><n-button :disabled="actionInProgress" @click="projectCreationMode = null">{{ t.back }}</n-button><n-button type="primary" :disabled="!downloadDirectory || !downloadProjectName.trim()" :loading="actionInProgress" @click="downloadProject">{{ t.downloadAndDeploy }}</n-button></n-space></n-space>
      <n-space v-else vertical :size="18"><n-form label-placement="top"><n-form-item :label="t.cloudName"><n-input v-model:value="cloudProjectName" :placeholder="t.cloudName" /></n-form-item><n-form-item :label="t.cloudUrl"><n-input v-model:value="cloudProjectUrl" placeholder="https://kira.example.com" /></n-form-item><n-form-item :label="cloudConnectionText.accessToken"><n-input v-model:value="cloudAccessToken" type="password" show-password-on="click" autocomplete="off" /><template #feedback>{{ cloudConnectionText.accessTokenHint }}</template></n-form-item></n-form><p class="modal-hint">{{ t.cloudHint }}</p><n-alert v-if="projectError" type="error" :show-icon="false">{{ projectError }}</n-alert><n-space justify="end"><n-button :disabled="actionInProgress" @click="projectCreationMode = null">{{ t.back }}</n-button><n-button type="primary" :disabled="!cloudProjectName.trim() || !cloudProjectUrl.trim()" :loading="actionInProgress" @click="connectCloudProject">{{ t.connectInstance }}</n-button></n-space></n-space>
      </n-modal>
      <n-modal v-model:show="showProjectSettingsModal" preset="card" :title="t.projectSettings" class="project-modal" :mask-closable="!projectSettingsSaving">
        <n-space v-if="editingProject" vertical :size="18"><p class="modal-hint">{{ t.projectSettingsSub }}</p><n-form label-placement="top"><n-form-item :label="t.projectName"><n-input v-model:value="projectSettingsName" :placeholder="t.projectName" /></n-form-item><template v-if="editingProject.type === 'local'"><n-form-item :label="t.webuiPort"><n-input-number v-model:value="projectSettingsPort" :min="1" :max="65535" :show-button="false" style="width: 100%" /><template #feedback>{{ t.webuiPortSub }}</template></n-form-item><n-collapse class="project-advanced-settings"><n-collapse-item :title="projectAdvancedSettingsText.title" name="advanced"><p class="modal-hint">{{ projectAdvancedSettingsText.subtitle }}</p><n-form-item :label="projectAdvancedSettingsText.launchArgs"><n-input v-model:value="projectSettingsLaunchArgs" placeholder="--env dev" /><template #feedback>{{ projectAdvancedSettingsText.launchArgsHint }}</template></n-form-item><n-form-item :label="projectAdvancedSettingsText.environmentVariables"><n-input v-model:value="projectSettingsEnvironmentVariables" type="textarea" :autosize="{ minRows: 3, maxRows: 8 }" /><template #feedback>{{ projectAdvancedSettingsText.environmentVariablesHint }}</template></n-form-item></n-collapse-item></n-collapse></template><template v-else><n-form-item :label="t.cloudUrl"><n-input v-model:value="projectSettingsUrl" placeholder="https://kira.example.com" /><template #feedback>{{ t.cloudUrlSub }}</template></n-form-item><n-form-item class="project-settings-token" :label="cloudConnectionText.accessToken"><n-input v-model:value="projectSettingsAccessToken" type="password" show-password-on="click" autocomplete="off" /><template #feedback>{{ cloudConnectionText.accessTokenUpdateHint }}</template></n-form-item></template></n-form><n-alert v-if="projectError" type="error" :show-icon="false">{{ projectError }}</n-alert><n-space justify="end"><n-button :disabled="projectSettingsSaving" @click="showProjectSettingsModal = false">{{ t.cancel }}</n-button><n-button type="primary" :disabled="!projectSettingsName.trim() || (editingProject.type === 'local' ? projectSettingsPort === null : !projectSettingsUrl.trim())" :loading="projectSettingsSaving" @click="saveProjectSettings">{{ t.save }}</n-button></n-space></n-space>
      </n-modal>
    </n-message-provider>
    </n-dialog-provider>
  </n-config-provider>
</template>
