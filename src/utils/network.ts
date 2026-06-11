/**
 * 网络状态检测
 *
 * 监听 `online`/`offline` 事件，提供响应式网络状态。
 * API 调用前检查此状态，断网时给出友好提示而非静默失败。
 */
import { ref, onMounted, onUnmounted } from 'vue'

const isOnline = ref(navigator.onLine)

let mounted = 0

export function useNetworkStatus() {
  function onOnline() {
    isOnline.value = true
  }

  function onOffline() {
    isOnline.value = false
  }

  if (mounted === 0) {
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
  }
  mounted++

  onMounted(() => { /* ensure lifecycle */ })

  onUnmounted(() => {
    mounted--
    if (mounted === 0) {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  })

  return { isOnline }
}
