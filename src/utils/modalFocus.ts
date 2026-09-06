import { nextTick, onUnmounted, watch, type Ref } from 'vue'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)]
    .filter(element => !element.closest('[inert]') && element.getAttribute('aria-hidden') !== 'true')
}

/**
 * 为自绘弹层提供一致的键盘行为：初始焦点、焦点限制、Esc 关闭与返回焦点。
 * 当弹层嵌套时，仅 DOM 中最上层的 aria-modal 对话框响应键盘事件。
 */
export function useModalFocus(
  visible: () => boolean,
  container: Ref<HTMLElement | null>,
  onEscape: () => void,
  initialFocus?: Ref<HTMLElement | null>,
) {
  let previousFocus: HTMLElement | null = null
  let listening = false

  function isTopmostDialog(): boolean {
    const dialogs = [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
    return dialogs[dialogs.length - 1] === container.value
  }

  function handleKeydown(event: KeyboardEvent) {
    const panel = container.value
    if (!visible() || !panel || !isTopmostDialog()) return

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      onEscape()
      return
    }

    if (event.key !== 'Tab') return
    const focusable = focusableElements(panel)
    if (focusable.length === 0) {
      event.preventDefault()
      panel.focus()
      return
    }

    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || !panel.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  function startListening() {
    if (listening) return
    document.addEventListener('keydown', handleKeydown, true)
    listening = true
  }

  function stopListening() {
    if (!listening) return
    document.removeEventListener('keydown', handleKeydown, true)
    listening = false
  }

  function restoreFocus() {
    if (previousFocus?.isConnected) previousFocus.focus()
    previousFocus = null
  }

  watch(visible, async value => {
    if (value) {
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      startListening()
      await nextTick()
      const target = initialFocus?.value ?? (container.value ? focusableElements(container.value)[0] : null)
      ;(target ?? container.value)?.focus()
    } else {
      stopListening()
      restoreFocus()
    }
  }, { immediate: true, flush: 'post' })

  onUnmounted(() => {
    stopListening()
    restoreFocus()
  })
}
