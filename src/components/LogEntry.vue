<script setup lang="ts">
import type { LogEntry } from '../../electron/types'
import { logColor } from './log-format'

defineProps<{ entry: LogEntry }>()
</script>

<template>
  <span v-if="entry.message !== undefined" class="log-entry"><span class="log-time">[{{ entry.time }}]</span> <span class="log-level" :class="`log-level-${entry.level.toLowerCase()}`">[{{ entry.displayLevel || entry.level }}]</span> <span v-if="entry.name !== undefined" class="log-name" :style="{ color: logColor(entry.color) }">[{{ entry.name }}] </span><span :style="{ color: logColor(entry.color) }">{{ entry.message }}</span></span>
  <span v-else class="log-entry">{{ entry.content }}</span>
</template>
