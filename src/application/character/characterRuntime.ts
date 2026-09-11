export type CharacterRenderKind = 'illustration' | 'live2d'

export interface CharacterLook {
  emotion: string
  stance: string
  costume: string
  screenPose: string
}

export interface CharacterCapabilities {
  emotions: readonly string[]
  stances: readonly string[]
  costumes: readonly string[]
  screenPoses: readonly string[]
  motions: readonly CharacterMotionCapability[]
  emotionDescriptions: Readonly<Record<string, string>>
}

export interface CharacterMotionCapability {
  group: string
  count: number
  description: string
}

export interface CharacterSelection {
  id: string
  render: CharacterRenderKind
  capabilities: CharacterCapabilities
  defaults: CharacterLook
}

export interface CharacterRuntimeSnapshot {
  characterId: string | null
  render: CharacterRenderKind | null
  look: CharacterLook | null
  capabilities: CharacterCapabilities | null
  revision: number
}

export interface CharacterRenderer {
  apply(snapshot: CharacterRuntimeSnapshot): void | Promise<void>
  execute?(command: CharacterRendererCommand): boolean | Promise<boolean>
  dispose?(): void | Promise<void>
}

export type CharacterRendererCommand = {
  type: 'play-motion'
  group: string
  index: number
}

interface RendererSlot {
  renderer: CharacterRenderer
  tail: Promise<void>
}

type RuntimeListener = (snapshot: CharacterRuntimeSnapshot) => void

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function assertSupported(value: string, supported: readonly string[], field: string): void {
  if (value === '' && supported.length === 0) return
  if (!supported.includes(value)) throw new Error(`Unsupported ${field}: ${value}`)
}

/**
 * Framework-independent owner of the active character and visual state.
 * Commands update state even when no renderer is attached; a newly attached
 * renderer immediately receives the latest complete snapshot.
 */
export class CharacterRuntime {
  private state: CharacterRuntimeSnapshot = {
    characterId: null,
    render: null,
    look: null,
    capabilities: null,
    revision: 0,
  }

  private readonly renderers = new Map<CharacterRenderKind, RendererSlot>()
  private readonly listeners = new Set<RuntimeListener>()

  constructor(private readonly onRendererError: (error: unknown) => void = () => {}) {}

  snapshot(): CharacterRuntimeSnapshot {
    return clone(this.state)
  }

  selectCharacter(selection: CharacterSelection): void {
    if (!selection.id.trim()) throw new Error('Character id must not be empty')
    this.assertLook(selection.defaults, selection.capabilities)
    this.state = {
      characterId: selection.id,
      render: selection.render,
      look: clone(selection.defaults),
      capabilities: clone(selection.capabilities),
      revision: this.state.revision + 1,
    }
    this.publish()
  }

  setLook(change: Partial<CharacterLook>): void {
    if (!this.state.look || !this.state.capabilities) throw new Error('No character is selected')
    const next = { ...this.state.look, ...change }
    this.assertLook(next, this.state.capabilities)
    if (
      next.emotion === this.state.look.emotion
      && next.stance === this.state.look.stance
      && next.costume === this.state.look.costume
      && next.screenPose === this.state.look.screenPose
    ) return
    this.state.look = next
    this.state.revision++
    this.publish()
  }

  /**
   * Best-effort restore of a persisted look. Unlike setLook (which validates
   * commands and throws), a value the current renderer cannot render falls back
   * to the current one, or to the first supported value. Never throws: restoring
   * a session must not fail because the character has no image for a label.
   */
  restoreLook(change: Partial<CharacterLook>): void {
    if (!this.state.look || !this.state.capabilities) return
    const capabilities = this.state.capabilities
    const current = this.state.look
    const take = (value: string | undefined, values: readonly string[], fallback: string): string => {
      if (value === undefined) return fallback
      if (values.includes(value)) return value
      return values.includes(fallback) ? fallback : (values[0] ?? '')
    }
    this.setLook({
      emotion: take(change.emotion, capabilities.emotions, current.emotion),
      stance: take(change.stance, capabilities.stances, current.stance),
      costume: take(change.costume, capabilities.costumes, current.costume),
      screenPose: take(change.screenPose, capabilities.screenPoses, current.screenPose),
    })
  }

  updateCapabilities(change: Partial<CharacterCapabilities>): void {
    if (!this.state.look || !this.state.capabilities) throw new Error('No character is selected')
    const capabilities: CharacterCapabilities = {
      ...this.state.capabilities,
      ...clone(change),
    }
    const supportedOrFirst = (value: string, values: readonly string[]) => (
      values.includes(value) ? value : (values[0] ?? '')
    )
    const look: CharacterLook = {
      emotion: supportedOrFirst(this.state.look.emotion, capabilities.emotions),
      stance: supportedOrFirst(this.state.look.stance, capabilities.stances),
      costume: supportedOrFirst(this.state.look.costume, capabilities.costumes),
      screenPose: supportedOrFirst(this.state.look.screenPose, capabilities.screenPoses),
    }
    this.assertLook(look, capabilities)
    this.state.capabilities = capabilities
    this.state.look = look
    this.state.revision++
    this.publish()
  }

  attachRenderer(kind: CharacterRenderKind, renderer: CharacterRenderer): () => void {
    const previous = this.renderers.get(kind)
    if (previous) void previous.tail.then(() => previous.renderer.dispose?.()).catch(this.onRendererError)

    const slot: RendererSlot = { renderer, tail: Promise.resolve() }
    this.renderers.set(kind, slot)
    if (this.state.render === kind && this.state.characterId) this.enqueueRender(slot, this.snapshot())

    return () => {
      if (this.renderers.get(kind) !== slot) return
      this.renderers.delete(kind)
      void slot.tail.then(() => renderer.dispose?.()).catch(this.onRendererError)
    }
  }

  subscribe(listener: RuntimeListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  async whenRendererSettled(kind: CharacterRenderKind): Promise<void> {
    await this.renderers.get(kind)?.tail
  }

  hasActiveRenderer(): boolean {
    return this.state.render !== null && this.renderers.has(this.state.render)
  }

  async executeRendererCommand(command: CharacterRendererCommand): Promise<boolean> {
    if (!this.state.render) return false
    const slot = this.renderers.get(this.state.render)
    if (!slot?.renderer.execute) return false
    let result = false
    slot.tail = slot.tail
      .then(async () => { result = await slot.renderer.execute!(clone(command)) })
      .catch(error => {
        this.onRendererError(error)
        result = false
      })
    await slot.tail
    return result
  }

  private publish(): void {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(clone(snapshot))
    if (!this.state.render) return
    const slot = this.renderers.get(this.state.render)
    if (slot) this.enqueueRender(slot, snapshot)
  }

  private enqueueRender(slot: RendererSlot, snapshot: CharacterRuntimeSnapshot): void {
    slot.tail = slot.tail
      .then(() => slot.renderer.apply(clone(snapshot)))
      .catch(this.onRendererError)
  }

  private assertLook(look: CharacterLook, capabilities: CharacterCapabilities): void {
    assertSupported(look.emotion, capabilities.emotions, 'emotion')
    assertSupported(look.stance, capabilities.stances, 'stance')
    assertSupported(look.costume, capabilities.costumes, 'costume')
    assertSupported(look.screenPose, capabilities.screenPoses, 'screen pose')
  }
}
